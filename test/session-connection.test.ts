import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RemoteTutor } from "../src/remote";
import { SessionConnectionCancelled, SessionConnectionFailure } from "../src/session-connection";
const assignment = {id:"synthetic",version:"1"};
const session = {schema:1,subject:"student",displayIdentity:"Synthetic",notice:"Notice",noticeVersion:"1",enrolments:[assignment]};
const busy = () => ({schema:1,code:"identity-unavailable",message:"Temporarily unavailable",retryable:true,requestId:randomUUID()});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
const options = () => ({endpoint:"https://course.example.test",token:"synthetic-key",directory:"/unused",assignment});

test("actual client retries explicit identity503, coalesces calls and authenticates freshly after settlement", async t => {
  t.mock.method(Math,"random",()=>0);
  let calls=0; const states:any[]=[];
  t.mock.method(globalThis,"fetch",async()=> ++calls<3 ? response(busy(),503) : response(session));
  const tutor=new RemoteTutor({...options(),onSessionConnectionState:s=>states.push(s)});
  const [a,b]=await Promise.all([tutor.session(),tutor.session()]);
  assert.equal(calls,3); assert.deepEqual(a,b); a.notice="changed"; assert.equal(b.notice,"Notice");
  assert.deepEqual(states.filter(s=>s.phase==="waiting").map(s=>s.delayMs),[250,500]);
  await tutor.session(); assert.equal(calls,4); await tutor.close();
});

test("persistent identity outage is bounded to four attempts with actionable feedback", async t => {
  t.mock.method(Math,"random",()=>0); let calls=0;
  t.mock.method(globalThis,"fetch",async()=> {calls++; return response(busy(),503);});
  const tutor=new RemoteTutor(options()); const began=performance.now();
  await assert.rejects(tutor.agree(),(e:any)=>e instanceof SessionConnectionFailure && e.reason==="busy");
  assert.equal(calls,4); assert.ok(performance.now()-began<10_500); assert.equal(tutor.ready,false); await tutor.close();
});

test("unknown/revoked and forbidden keys, malformed envelopes and invalid successes never retry", async t => {
  let value:Response; let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++; return value;});
  const bad = [response({},401),response({},403),response(busy(),429),response({...busy(),retryable:false},503),
    response({...busy(),code:"unavailable"},503),response({...busy(),extra:1},503),response({...busy(),requestId:"bad"},503),
    response({...busy(),message:"x".repeat(4097)},503),response({schema:1},200),
    new Response('{"schema":1,"schema":1}',{status:503,headers:{"content-type":"application/json"}}),
    new Response('bad',{status:503,headers:{"content-type":"text/html"}}),
    new Response('{"message":"\\ud800"}',{status:503,headers:{"content-type":"application/json"}})];
  for (value of bad) { const tutor=new RemoteTutor(options()); const before=calls; await assert.rejects(tutor.agree()); assert.equal(calls,before+1); await tutor.close(); }
});

test("cancel during backoff or ignored-abort fetch rejects promptly and cannot restore agreement", async t => {
  let release!:(value:Response)=>void; let calls=0;
  t.mock.method(globalThis,"fetch",()=>{calls++; return new Promise<Response>(r=>{release=r;});});
  const tutor=new RemoteTutor(options()); const pending=tutor.agree(); tutor.cancelSessionConnection();
  await assert.rejects(pending,SessionConnectionCancelled); release(response(session)); await new Promise(r=>setImmediate(r));
  assert.equal(tutor.ready,false); await assert.rejects(tutor.confirm(),/Read the service notice/);
  const next=tutor.agree(); release(response(session)); assert.equal(await next,"student");
  await tutor.close(); await assert.rejects(tutor.session(),SessionConnectionCancelled); assert.equal(calls,2);
  t.mock.method(globalThis,"fetch",async()=>response(busy(),503));
  let waiting!:()=>void; const waited=new Promise<void>(r=>{waiting=r;});
  const other=new RemoteTutor({...options(),onSessionConnectionState:s=>{if(s.phase==="waiting")waiting();}});
  const retry=other.agree(); await waited; other.cancelSessionConnection(); await assert.rejects(retry,SessionConnectionCancelled); await other.close();
});

test("endpoint/key replacement does not reuse mutable credentials or apply late identity", async t => {
  const requested:string[]=[]; let oldReply!:(value:Response)=>void;
  t.mock.method(globalThis,"fetch",(url:any,init:any)=>{requested.push(String(url)+":"+init.headers.Authorization);
    return String(url).includes("new.example") ? Promise.resolve(response({...session,subject:"new-student"})) : new Promise<Response>(r=>{oldReply=r;});});
  const config=options(); const old=new RemoteTutor(config); config.token="mutated-key";
  const pending=old.agree(); await old.close(); await assert.rejects(pending,SessionConnectionCancelled);
  const replacement=new RemoteTutor({...options(),endpoint:"https://new.example.test",token:"new-key"});
  assert.equal(await replacement.agree(),"new-student"); oldReply(response(session)); await new Promise(r=>setImmediate(r));
  assert.equal(old.ready,false); assert.equal(requested[0],"https://course.example.test/v1/session:Bearer synthetic-key");
  assert.equal(requested[1],"https://new.example.test/v1/session:Bearer new-key"); await replacement.close();
});

test("session retry does not replay consent POST", async t => {
  const methods:string[]=[];
  t.mock.method(globalThis,"fetch",async(_url:any,init:any)=>{methods.push(init.method);return init.method==="GET"?response(session):response(busy(),503);});
  const {mkdtemp,rm}=await import("node:fs/promises"); const {tmpdir}=await import("node:os"); const {join}=await import("node:path");
  const directory=await mkdtemp(join(tmpdir(),"auth-retry-")); const tutor=new RemoteTutor({...options(),directory});
  try {await tutor.agree(); await assert.rejects(tutor.confirm()); assert.equal(methods.filter(m=>m==="POST").length,1);}
  finally {await tutor.close();await rm(directory,{recursive:true,force:true});}
});

test("late asynchronous approval and post-validation cancellation cannot update identity or agreement", async t => {
  let release!:()=>void, entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;});
  t.mock.method(globalThis,"fetch",async()=>response({...session,recovery:{schema_version:2,archive_policy:{store_id:"trial",policy_id:"test"}}}));
  const tutor=new RemoteTutor({...options(),archivePolicyMode:true,afterArchiveConfirmation:async()=>undefined,
    beforeArchiveActivity:async()=>{entered();await new Promise<void>(r=>{release=r;});}});
  (tutor as any).confirmed=true;
  const pending=tutor.session();await started;tutor.cancelSessionConnection();await assert.rejects(pending,SessionConnectionCancelled);
  release();await new Promise(r=>setImmediate(r));assert.equal((tutor as any).identity,undefined);await tutor.close();
  let next:RemoteTutor;
  next=new RemoteTutor({...options(),onSessionConnectionState:s=>{if(s.phase==="connected")next.cancelSessionConnection();}});
  await assert.rejects(next.agree(),SessionConnectionCancelled);await assert.rejects(next.confirm(),/Read the service notice/);await next.close();
});

test("ten-second deadline bounds a fetch that ignores abort even with a longer request timeout", async t => {
  let calls=0;t.mock.method(globalThis,"fetch",()=>{calls++;return new Promise<Response>(()=>undefined);});
  const tutor=new RemoteTutor({...options(),requestTimeoutMs:60_000});const began=performance.now();
  await assert.rejects(tutor.agree(),SessionConnectionFailure);
  assert.equal(calls,1);assert.ok(performance.now()-began<11_000);await tutor.close();
});

test("informational refresh retains prior readiness only for temporary faults, never401/403 or cancelled generations", async t => {
  t.mock.method(Math,"random",()=>0);
  let status=503, calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return response(busy(),status);});
  for (status of [503,500,401,403]) {
    const tutor=new RemoteTutor(options());(tutor as any).agreed=true;(tutor as any).confirmed=true;
    const before=calls;await tutor.refreshAllowance();
    assert.equal(tutor.ready,status===503||status===500);assert.equal(calls-before,status===503?4:1);await tutor.close();
  }
  let release!:(value:Response)=>void;
  t.mock.method(globalThis,"fetch",()=>new Promise<Response>(r=>{release=r;}));
  const tutor=new RemoteTutor(options());(tutor as any).agreed=true;(tutor as any).confirmed=true;
  const refresh=tutor.refreshAllowance();tutor.decline();await refresh;release(response(session));await new Promise(r=>setImmediate(r));
  assert.equal(tutor.ready,false);await tutor.close();
});

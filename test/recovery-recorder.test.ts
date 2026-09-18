import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ReplyCheckpoints, recoveryEvents, type RecoverableTurn } from "../src/recovery/recorder";
import type { RecordEvent } from "../src/recovery/protocol";
const assignment={id:"tutor-test-primes",version:"1.0.0"};
test("recorder preserves stable event IDs and separates prompt, reply and outcome",()=>{
 let sequence=0;
 const turn:RecoverableTurn={submission:{schema:1,submissionId:randomUUID(),sessionId:randomUUID(),capturedAt:new Date().toISOString(),assignment,prompt:"Question",snapshot:{path:"assignment.py",language:"python",text:"pass",documentVersion:1,selection:null}},attempts:[]};
 const first=recoveryEvents(turn,()=>++sequence);assert.equal(first.length,1);
 const aid=randomUUID();turn.attempts.push({attemptId:aid,state:"completed",result:{prose:"Guidance",model:"fake",usage:null},error:null});
 const all=recoveryEvents(turn,()=>++sequence);assert.deepEqual(all[0],first[0]);assert.deepEqual(all.map(e=>e.event_kind),["submission","reply_final","outcome"]);
 assert.deepEqual(recoveryEvents(JSON.parse(JSON.stringify(turn))),all);assert.equal(new Set(all.map(e=>e.event_id)).size,3);
});
test("checkpoint adapter stores bounded deltas, retries identical writes and marks interrupted output",async()=>{
 let now=Date.now(),sequence=0;const saved:RecordEvent[]=[];let fail=true;
 const writer=new ReplyCheckpoints({turnId:randomUUID(),sessionId:randomUUID(),attemptId:randomUUID(),assignment,nextSequence:()=>++sequence,now:()=>now,intervalMs:2000,maxBytes:8,persist:async event=>{saved.push(event);if(fail){fail=false;throw Error("lost acknowledgement");}}});
 await writer.append("abc");assert.equal(saved.length,0);now+=2000;
 await assert.rejects(writer.checkpoint());await writer.checkpoint();assert.deepEqual(saved[0],saved[1]);
 await writer.append("def");await writer.finish(false);
 assert.equal(saved.at(-1)!.event_kind,"outcome");assert.equal(JSON.parse(saved.at(-1)!.payload_utf8).data.status,"interrupted");
 const unique=[...new Map(saved.filter(e=>e.event_kind==="reply_checkpoint").map(e=>[e.event_id,e])).values()];assert.equal(unique.map(e=>JSON.parse(e.payload_utf8).data.text).join(""),"abcdef");
 assert.ok(unique.every(e=>JSON.parse(e.payload_utf8).data.complete===false));
});
test("a failed final checkpoint retains the same immutable terminal event on explicit retry",async()=>{
 const saved:RecordEvent[]=[];let sequence=0,failed=false;
 const writer=new ReplyCheckpoints({turnId:randomUUID(),sessionId:randomUUID(),attemptId:randomUUID(),assignment,nextSequence:()=>++sequence,persist:async e=>{saved.push(e);if(e.event_kind==="reply_final"&&!failed){failed=true;throw Error("write acknowledgement lost");}}});
 await writer.append("hello");await assert.rejects(writer.finish(true));await assert.rejects(writer.finish(false));await writer.finish(true);
 const final=saved.filter(e=>e.event_kind==="reply_final");assert.equal(final.length,2);assert.deepEqual(final[0],final[1]);await writer.finish(true);assert.equal(saved.filter(e=>e.event_kind==="reply_final").length,2);
});
test("checkpoint timer persists a stalled stream without waiting for its next token",async()=>{
 const events:RecordEvent[]=[];let sequence=0;
 const writer=new ReplyCheckpoints({turnId:randomUUID(),sessionId:randomUUID(),attemptId:randomUUID(),assignment,nextSequence:()=>++sequence,intervalMs:15,persist:async e=>{events.push(e);}});
 await writer.append("partial before stall");await new Promise(resolve=>setTimeout(resolve,50));writer.stop();
 assert.equal(events.length,1);assert.equal(events[0]!.event_kind,"reply_checkpoint");assert.equal(JSON.parse(events[0]!.payload_utf8).data.complete,false);
});

test("copied turn histories can reuse a session sequence for distinct later observations",()=>{
 const turn:RecoverableTurn={submission:{schema:1,submissionId:randomUUID(),sessionId:randomUUID(),capturedAt:"2026-09-14T00:00:00.000Z",assignment,prompt:"Synthetic",snapshot:{path:"assignment.py",language:"python",text:"pass",documentVersion:1,selection:null}},attempts:[]};
 let initialSequence=0;recoveryEvents(turn,()=>++initialSequence);
 const first=structuredClone(turn),second=structuredClone(turn);
 first.attempts.push({attemptId:randomUUID(),state:"failed",result:null,error:"provider-unavailable"});
 second.attempts.push({attemptId:randomUUID(),state:"cancelled",result:null,error:null});
 let leftSequence=initialSequence,rightSequence=initialSequence;
 const left=recoveryEvents(first,()=>++leftSequence).at(-1)!;
 const right=recoveryEvents(second,()=>++rightSequence).at(-1)!;
 assert.equal(left.session_id,right.session_id);
 assert.equal(left.client_sequence,right.client_sequence);
 assert.notEqual(left.event_id,right.event_id);
 assert.notEqual(left.payload_sha256,right.payload_sha256);
 // Event IDs remain the logical identity; a session/sequence UNIQUE constraint
 // would reject one genuine event after copied histories diverge.
});

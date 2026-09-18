import { checkSessionSignal, abortable, sessionGet, reportSession, SessionConnectionCancelled, SessionConnectionFailure, type SessionConnectionState } from "./session-connection";
import { validateTokenAllowance, tokenAllowanceLabel, tokenAllowanceDetails, type TokenAllowance } from "./token-allowance";
import { parseRecoveryJson } from "./recovery/json";
import type { RecoveryQueue } from "./recovery/queue";
import { recoveryEvents, type RecoveryStamp } from "./recovery/recorder";
import { sameContext, validateArchivePolicy, type ArchivePolicy } from "./recovery/protocol";
import { assignmentFiles, validateDefinition, validateAssignmentRef, type AssignmentDefinition, type AssignmentFile } from "./assignment";
import { randomUUID } from "node:crypto";
import { mkdir, open, link, unlink, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AssignmentRef, type Snapshot, type Mode } from "./domain";
import { submission as validateSubmission, digest, reply as validateReply, editEvent as validateEditEvent, type EditEvent, type Submission, type ModelReply, type Observation } from "./service/protocol";

export class AssignmentFolderError extends Error {}
export type RemoteCourse = { id: string; title: string; activeAssignment: AssignmentRef | null };
export type Session = { tokenAllowance?: TokenAllowance; subclass?: { id: string; title: string }; recovery?: { schema_version: number; archive_policy?: ArchivePolicy }; course?: RemoteCourse; schema: 1; subject: string; displayIdentity: string; noticeVersion: string; notice: string; enrolments: AssignmentRef[] };
type Receipt = { schema: 1; subject: string; resourceId: string; payloadDigest: string; receivedAt: string };
type RemoteAttempt = { attemptId: string; state: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown"; result: ModelReply | null; error: string | null };
type SavedEdit = { payload: EditEvent; receipt?: Receipt; fromService?: boolean };
type RecordTurn = { recovery?: Record<string, RecoveryStamp>; schema: 1; sequence: number; submission: Submission; receipt?: Receipt; observations?: { payload: Observation; receipt?: Receipt }[]; editEvents?: SavedEdit[]; attempts: RemoteAttempt[] };
export type RemoteTurn = { recordedByService: boolean; submission: Submission & { id: string; ts: string }; attempts: { start: { attemptId: string }; outcome: { status: RemoteAttempt["state"]; reply: ModelReply | null; error: string | null }; editEvents: EditEvent[]; editStatus: EditEvent["kind"] | null; editPending: boolean }[] };
export type RemoteOptions = { onSessionConnectionState?: (state: SessionConnectionState) => void; archivePolicyMode?: boolean; beforeArchiveActivity?: (session: Session) => Promise<void>; afterArchiveConfirmation?: (session: Session) => Promise<void>; recoveryQueue?: RecoveryQueue; directory: string; endpoint: string; token: string; assignment: AssignmentRef; allowLoopback?: boolean; requestTimeoutMs?: number; pollIntervalMs?: number; pollTimeoutMs?: number; guard?: () => void; onRequestStarted?: () => void };
class CourseTransportError extends Error {}
class RequestError extends Error { constructor(readonly status: number, expectedEndpoint?: string) { super(expectedEndpoint ? `This key belongs to another course endpoint. Set the course service URL to ${expectedEndpoint}, then run Assignment Guide: Connect to Course Service and enter your key again. Your existing local records are retained.` : `Course service request failed (${status}). Your original submission remains stored locally.`); } }
async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > limit) throw new Error("Response too large."); chunks.push(chunk.value); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function endpointError(response: Response): Promise<RequestError> {
  try {
    if (response.status !== 403 || !response.headers.get("content-type")?.startsWith("application/json")) throw new Error();
    const value = parseRecoveryJson(await readBoundedResponse(response, 4096)) as Record<string, unknown>;
    if (!value || Object.keys(value).sort().join() !== "code,expectedEndpoint,message,requestId,retryable,schema" ||
        value.schema !== 1 || value.code !== "wrong-course-endpoint" || value.retryable !== false ||
        typeof value.message !== "string" || value.message.length > 500 || typeof value.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId) ||
        typeof value.expectedEndpoint !== "string" || value.expectedEndpoint.length > 300) throw new Error();
    const url = new URL(value.expectedEndpoint);
    if (url.protocol !== "https:" || url.origin !== value.expectedEndpoint || url.username || url.password ||
        url.search || url.hash || url.pathname !== "/") throw new Error();
    return new RequestError(403, url.origin);
  } catch { return new RequestError(response.status); }
  finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
}
/** Synthetic pilot client. Immutable local revisions precede every remote dispatch. */
export class RemoteTutor {
  private readonly endpoint: string;
  private readonly token: string;
  private connectionGeneration = 0;
  private closed = false;
  private sessionFlight: { generation: number; controller: AbortController; promise: Promise<Session> } | undefined;
  private checkConnection(generation: number): void {
    if (this.closed || generation !== this.connectionGeneration) throw new SessionConnectionCancelled();
  }
  private identity: Session | undefined;
  private authoritativeAssignment: AssignmentDefinition | undefined;
  private definitionDigest: string | undefined;
  private agreed = false;
  private confirmed = false;
  private confirmedIdentity = false;
  private latestCourse: RemoteCourse | undefined;
  private running = false;
  private cancelled = false;
  private sequence = 0;
  private recoverySequence = 0;
  private allowance: TokenAllowance | undefined;
  private allowanceStale = true;
  private readonly sessionId = randomUUID();
  constructor(private readonly options: RemoteOptions) {
    validateAssignmentRef(options.assignment);
    if (options.archivePolicyMode && (!options.beforeArchiveActivity || !options.afterArchiveConfirmation)) throw new Error("Archive mode requires durable host approval callbacks.");
    const url = new URL(options.endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        (url.protocol !== "https:" && !(options.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1"))) throw new Error("Use an HTTPS course service origin, or explicitly enable the local 127.0.0.1 pilot.");
    if (!options.token || /\s/.test(options.token)) throw new Error("A course service token is required.");
    this.endpoint = url.origin; this.token = options.token;
  }
  /** Attach only between verified agreement and confirmation, before any record recovery. */
  attachRecoveryQueue(queue: RecoveryQueue | undefined): void {
    if (this.running || this.confirmed) throw new Error("Reconnect before changing recovery storage.");
    if (queue && (!this.agreed || !this.identity?.course || !sameContext(queue.context,
      { origin: this.endpoint, subject: this.identity.subject, courseId: this.identity.course.id }))) throw new Error("Recovery queue belongs to a different verified identity.");
    this.options.recoveryQueue = queue;
  }
  get course(): RemoteCourse | undefined { return this.latestCourse ? structuredClone(this.latestCourse) : undefined; }
  get assignmentDefinition(): AssignmentDefinition | undefined { return this.authoritativeAssignment ? structuredClone(this.authoritativeAssignment) : undefined; }
  get files(): AssignmentFile[] { return this.authoritativeAssignment ? structuredClone([...assignmentFiles(this.authoritativeAssignment)]) : []; }
  get ready(): boolean { return this.agreed && this.confirmed; }
  get canReadHistory(): boolean { return this.agreed && this.confirmedIdentity && !!this.identity; }
  get confirmedSubject(): string | undefined { return this.canReadHistory ? this.identity?.subject : undefined; }
  allowanceLabel(stale = false): string { return tokenAllowanceLabel(this.allowance, stale || this.allowanceStale); }
  allowanceDetails(): string { return tokenAllowanceDetails(this.allowance); }
  async refreshAllowance(): Promise<void> {
    const confirmed = this.confirmed, generation = this.connectionGeneration;
    try { await this.session(); }
    catch (error) {
      if (generation !== this.connectionGeneration || this.closed) return;
      this.allowanceStale = true;
      // A balance refresh is informational. A transport outage must not turn a
      // completed response into a failed submission; sends still revalidate session.
      if ((error instanceof SessionConnectionFailure && ["busy", "unavailable"].includes(error.reason)) || error instanceof CourseTransportError || (error instanceof RequestError && [429, 500, 502, 503, 504].includes(error.status))) this.confirmed = confirmed;
    }
  }
  get busy(): boolean { return this.running; }
  private async request(path: string, method = "GET", payload?: unknown): Promise<any> {
    this.allowanceStale = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10_000);
    try {
      const response = await fetch(this.endpoint + path, { method, redirect: "error", signal: controller.signal,
        headers: { ...(path === "/v1/session" && this.options.archivePolicyMode ? { "X-Record-Protocol": "2" } : {}), "User-Agent": "AssignmentTutorV2/0.3 (course-client)", Authorization: `Bearer ${this.token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!response.ok) throw await endpointError(response);
      if (!response.headers.get("content-type")?.startsWith("application/json")) throw new Error("Invalid course service response.");
      const text = await readBoundedResponse(response, 1_048_576);
      return this.options.archivePolicyMode && path === "/v1/session" ? parseRecoveryJson(text) : JSON.parse(text);
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new CourseTransportError("The course service could not be reached or returned an invalid response. Keep the original request ID and reconnect.");
    } finally { clearTimeout(timer); }
  }
  async session(): Promise<Session> {
    if (this.closed) throw new SessionConnectionCancelled();
    let operation = this.sessionFlight;
    if (!operation) {
      const controller = new AbortController(), generation = this.connectionGeneration;
      const flight = { controller, generation, promise: Promise.resolve(undefined as unknown as Session) };
      this.sessionFlight = flight; operation = flight;
      const deadline = setTimeout(() => controller.abort(new SessionConnectionFailure("unavailable")),10_000);
      flight.promise = abortable(this.loadSession(controller.signal, generation),controller.signal).then(value => {
        this.checkConnection(generation); reportSession(this.options.onSessionConnectionState, {phase:"connected"}); return value;
      }).catch(error => {
        // A cancelled old generation must never clear readiness of a replacement operation.
        if (generation === this.connectionGeneration) this.confirmed = false;
        if (generation === this.connectionGeneration && !(error instanceof SessionConnectionCancelled)) reportSession(this.options.onSessionConnectionState,
          {phase:"failed",reason:error instanceof SessionConnectionFailure ? error.reason : "invalid-response"});
        throw error;
      }).finally(() => { clearTimeout(deadline); if (this.sessionFlight === flight) this.sessionFlight = undefined; });
    }
    const result = await operation.promise; this.checkConnection(operation.generation);
    return structuredClone(result);
  }
  private async loadSession(signal: AbortSignal, generation: number): Promise<Session> {
    try {
      const s = await sessionGet({endpoint:this.endpoint,token:this.token,signal,timeoutMs:this.options.requestTimeoutMs,
        archive:this.options.archivePolicyMode,forbiddenMessage:async response => (await endpointError(response)).message,report:state => { this.checkConnection(generation); checkSessionSignal(signal); reportSession(this.options.onSessionConnectionState,state); }});
      this.checkConnection(generation); checkSessionSignal(signal);
      if (this.identity && (s?.subject !== this.identity.subject || s?.noticeVersion !== this.identity.noticeVersion ||
          s?.notice !== this.identity.notice || s?.displayIdentity !== this.identity.displayIdentity)) {
        this.confirmedIdentity = false;
        throw new Error("Identity or notice changed. Reopen the tutor to confirm again.");
      }
      if (!s || s.schema !== 1 || typeof s.subject !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(s.subject) ||
          typeof s.displayIdentity !== "string" || typeof s.notice !== "string" || !s.notice.trim() || typeof s.noticeVersion !== "string" || !Array.isArray(s.enrolments)) throw new Error("Invalid identity, notice or assignment enrolment from course service.");
      if (Object.hasOwn(s, "subclass")) {
        const c = s.subclass;
        if (!s.course || !c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).sort().join() !== "id,title" ||
            typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(c.id) || typeof c.title !== "string" ||
            !c.title.trim() || Buffer.byteLength(c.title) > 200 || /[\x00-\x1f\x7f]/.test(c.title)) throw new Error("Invalid subclass information from the service.");
      }
      if (this.identity && (this.identity.subclass?.id !== s.subclass?.id || this.identity.subclass?.title !== s.subclass?.title)) {
        this.confirmedIdentity = false;
        throw new Error("Subclass changed. Reopen the tutor and confirm your details.");
      }
      if (this.options.archivePolicyMode) {
        if (s.recovery?.schema_version !== 2) throw new Error("Archive protocol approval is required.");
        const policy = validateArchivePolicy(s.recovery.archive_policy);
        if (this.identity && (this.identity.recovery?.archive_policy?.store_id !== policy.store_id ||
            this.identity.recovery?.archive_policy?.policy_id !== policy.policy_id || this.identity.notice !== s.notice)) throw new Error("Archive policy or notice changed. Reopen the tutor to confirm again.");
        if (this.confirmed) await this.options.beforeArchiveActivity?.(s);
        this.checkConnection(generation); checkSessionSignal(signal);
      }
      const exactRef = (value: unknown): AssignmentRef => {
        validateAssignmentRef(value);
        if (Object.keys(value as object).length !== 2 || !Object.hasOwn(value as object, "id") || !Object.hasOwn(value as object, "version")) throw new Error("Invalid course assignment reference.");
        return value as AssignmentRef;
      };
      s.enrolments.forEach(exactRef);
      if (Object.hasOwn(s, "course")) {
        const c = s.course;
        if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length !== 3 ||
            !["id", "title", "activeAssignment"].every(k => Object.hasOwn(c, k)) ||
            typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(c.id) ||
            typeof c.title !== "string" || !c.title.trim() || Buffer.byteLength(c.title) > 200 || /[\x00-\x1f\x7f]/.test(c.title)) throw new Error("Invalid course information from the service.");
        if (c.activeAssignment !== null) exactRef(c.activeAssignment);
        if (s.enrolments.length !== (c.activeAssignment === null ? 0 : 1) ||
            (c.activeAssignment !== null && (s.enrolments[0].id !== c.activeAssignment.id || s.enrolments[0].version !== c.activeAssignment.version))) throw new Error("Course enrolments do not match its active assignment.");
        this.latestCourse = structuredClone(c);
        if (c.activeAssignment === null) throw new Error(`${c.title} (${c.id}) has no active assignment. Keep your work and ask your teacher when the next assignment opens.`);
        if (c.activeAssignment.id !== this.options.assignment.id || c.activeAssignment.version !== this.options.assignment.version) throw new AssignmentFolderError(`This folder is not for your current assignment. ${c.title} (${c.id}) requires assignment ${c.activeAssignment.id}, version ${c.activeAssignment.version}. Open its matching assignment repository before using the tutor.`);
      }
      if (this.identity && (this.identity.course?.id !== s.course?.id || this.identity.course?.title !== s.course?.title ||
          this.identity.course?.activeAssignment?.id !== s.course?.activeAssignment?.id || this.identity.course?.activeAssignment?.version !== s.course?.activeAssignment?.version)) throw new Error("Course or active assignment changed. Reopen the tutor and confirm the current course identity.");
      if (!s.enrolments.some((a: AssignmentRef) => a.id === this.options.assignment.id && a.version === this.options.assignment.version)) throw new Error("Invalid identity, notice or assignment enrolment from course service.");
      if (Object.hasOwn(s, "tokenAllowance") && !s.course) throw new Error("Token allowance requires a verified course.");
      const allowance = Object.hasOwn(s, "tokenAllowance") ? validateTokenAllowance(s.tokenAllowance, this.options.assignment) : undefined;
      if (allowance && this.allowance?.epoch.id === allowance.epoch.id &&
          (allowance.epoch.startedAt !== this.allowance.epoch.startedAt || allowance.revision < this.allowance.revision ||
           (allowance.revision === this.allowance.revision && allowance.limit !== this.allowance.limit) || allowance.used < this.allowance.used)) {
        throw new Error("Assignment token allowance moved backwards.");
      }
      this.allowance = allowance; this.allowanceStale = false;
      this.identity = s; return structuredClone(s);
    } catch (error) { this.checkConnection(generation); checkSessionSignal(signal); this.confirmed = false; throw error; }
  }
  async agree(): Promise<string> { const generation = this.connectionGeneration; const s = await this.session(); this.checkConnection(generation); this.agreed = true; return s.subject; }
  async confirm(): Promise<void> {
    const generation = this.connectionGeneration;
    if (!this.agreed || !this.identity) throw new Error("Read the service notice and confirm your identity first.");
    this.confirmed = false;
    await this.session(); this.checkConnection(generation);
    if (this.options.recoveryQueue && (!this.identity.course || !sameContext(this.options.recoveryQueue.context,
      { origin: this.endpoint, subject: this.identity.subject, courseId: this.identity.course.id }))) throw new Error("Recovery queue belongs to a different course account or origin.");
    await this.bind(); this.checkConnection(generation);
    const payload = { schema: 1, noticeVersion: this.identity.noticeVersion, confirmedSubject: this.identity.subject };
    const receipt = await this.request("/v1/consents", "POST", payload);
    this.checkConnection(generation);
    if (receipt?.subject !== this.identity.subject || receipt.payloadDigest !== digest(payload)) throw new Error("Invalid consent receipt.");
    const a = this.options.assignment;
    const definition = await this.request(`/v1/assignments/${encodeURIComponent(a.id)}/versions/${encodeURIComponent(a.version)}`);
    this.checkConnection(generation);
    if (definition?.schema !== 1 || definition.subject !== this.identity.subject || definition.definition?.id !== a.id || definition.definition?.version !== a.version ||
        definition.definitionDigest !== digest(definition.definition)) throw new Error("Invalid authoritative assignment definition.");
    validateDefinition(definition.definition);
    if (JSON.stringify(definition.allowedFiles) !== JSON.stringify(assignmentFiles(definition.definition).map(file => file.path))) throw new Error("Invalid authoritative assignment files.");
    this.authoritativeAssignment = structuredClone(definition.definition);
    this.definitionDigest = definition.definitionDigest;
    if (this.options.archivePolicyMode) await this.options.afterArchiveConfirmation?.(await this.session());
    this.checkConnection(generation);
    this.confirmed = true; this.confirmedIdentity = true;
    try { await this.recover(); } catch { /* Offline records remain visible and recoverable through Sync. */ }
    if (!this.ready) throw new Error("The course session changed during recovery. Your saved records are retained; reopen the tutor to confirm the current assignment.");
  }
  decline(): void { this.confirmedIdentity = false; this.authoritativeAssignment = undefined; this.agreed = false; this.confirmed = false; this.cancel(); }
  cancelSessionConnection(): void {
    this.connectionGeneration++;
    const flight = this.sessionFlight; this.sessionFlight = undefined;
    if (flight) { flight.controller.abort(); reportSession(this.options.onSessionConnectionState, {phase:"cancelled"}); }
  }
  cancel(): void { this.cancelled = true; this.cancelSessionConnection(); }
  async close(): Promise<void> { this.closed = true; this.cancel(); }
  private gate(editRecovery = false): void { if (!this.ready && !(editRecovery && this.agreed && this.confirmedIdentity && this.identity)) throw new Error("Agree to the notice and confirm your identity first."); this.options.guard?.(); }
  private async write(name: string, value: unknown): Promise<void> {
    this.options.guard?.(); await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.directory, `${randomUUID()}.tmp`); const target = join(this.options.directory, name);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    try {
      this.options.guard?.();
      try { await link(temporary, target); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(target, "utf8") !== JSON.stringify(value)) throw e;
      }
      if (process.platform !== "win32") { const dir = await open(this.options.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private async bind(): Promise<void> {
    await this.write("binding.json", { schema: 1, endpoint: this.endpoint, subject: this.identity!.subject, assignment: this.options.assignment });
  }
  private async records(): Promise<RecordTurn[]> {
    this.gate(true); let names: string[];
    try { names = await readdir(this.options.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const latest = new Map<string, RecordTurn>();
    for (const name of names.filter(n => n.endsWith(".json") && n !== "binding.json")) {
      const r = JSON.parse(await readFile(join(this.options.directory, name), "utf8")) as RecordTurn;
      validateSubmission(r.submission);
      if (r.schema !== 1 || !Number.isSafeInteger(r.sequence) || !Array.isArray(r.attempts)) throw new Error("Invalid local course record.");
      for (const a of r.attempts) this.validateAttempt(a, r.submission.submissionId, a.attemptId, true);
      if (r.editEvents !== undefined && !Array.isArray(r.editEvents)) throw new Error("Invalid local edit records.");
      const editIds = new Set<string>();
      for (const event of r.editEvents ?? []) {
        const payload = validateEditEvent(event.payload);
        if (payload.submissionId !== r.submission.submissionId || !r.attempts.some(a => a.attemptId === payload.attemptId) || editIds.has(payload.eventId) ||
            (event.fromService !== undefined && event.fromService !== true)) throw new Error("Invalid local edit records.");
        if (event.receipt) this.editReceipt(event.receipt, payload);
        editIds.add(payload.eventId);
      }
      if (r.recovery) {
        if (typeof r.recovery !== "object" || Array.isArray(r.recovery)) throw new Error("Invalid local recovery metadata.");
        for (const stamp of Object.values(r.recovery)) {
          if (!Number.isSafeInteger(stamp.client_sequence) || stamp.client_sequence < 1) throw new Error("Invalid local recovery sequence.");
          this.recoverySequence = Math.max(this.recoverySequence, stamp.client_sequence);
        }
      }
      this.sequence = Math.max(this.sequence, r.sequence);
      if ((latest.get(r.submission.submissionId)?.sequence ?? -1) < r.sequence) latest.set(r.submission.submissionId, r);
    }
    return [...latest.values()].sort((a, b) => a.submission.capturedAt.localeCompare(b.submission.capturedAt));
  }
  private async save(r: RecordTurn): Promise<void> {
    const recovery = this.options.recoveryQueue ? recoveryEvents(r, () => ++this.recoverySequence) : [];
    r.sequence = ++this.sequence;
    await this.write(`${String(r.sequence).padStart(16, "0")}-${randomUUID()}.json`, r);
    for (const event of recovery) await this.options.recoveryQueue!.enqueue(event);
  }
  private async recoverRecordEvents(r: RecordTurn): Promise<void> {
    if (!this.options.recoveryQueue) return;
    // Old local records acquire stable metadata once; routine replay does not
    // duplicate a whole conversation revision merely to poll its receipts.
    const before = Object.keys(r.recovery ?? {}).length;
    const events = recoveryEvents(r, () => ++this.recoverySequence);
    if (Object.keys(r.recovery ?? {}).length !== before) await this.save(r);
    else for (const event of events) await this.options.recoveryQueue.enqueue(event);
  }
  async history(): Promise<RemoteTurn[]> {
    return (await this.records()).map(r => ({ recordedByService: !!r.receipt, submission: { ...r.submission, id: r.submission.submissionId, ts: r.submission.capturedAt },
      attempts: r.attempts.map(a => ({ start: { attemptId: a.attemptId }, outcome: { status: a.state, reply: a.result, error: a.error },
        editEvents: (r.editEvents ?? []).filter(e => e.payload.attemptId === a.attemptId).map(e => structuredClone(e.payload)),
        editStatus: this.editState(r, a.attemptId), editPending: (r.editEvents ?? []).some(e => e.payload.attemptId === a.attemptId && !e.receipt && !e.fromService) })) }));
  }
  async editProposal(submissionId: string, attemptId: string) {
    const r = (await this.records()).find(r => r.submission.submissionId === submissionId);
    const a = r?.attempts.find(a => a.attemptId === attemptId);
    if (!r || a?.state !== "completed" || !a.result?.edit) return undefined;
    return { edit: structuredClone(a.result.edit), snapshot: structuredClone(r.submission.snapshot) };
  }
  private editState(r: RecordTurn, attemptId: string): EditEvent["kind"] | null {
    const events = (r.editEvents ?? []).filter(e => e.payload.attemptId === attemptId);
    const final = [...events].reverse().find(e => !["accepted", "rejected"].includes(e.payload.kind));
    if (final) return final.payload.kind;
    if (events.some(e => e.payload.kind === "rejected")) return "rejected";
    // Acceptance records intent, not proof of application. In particular, after
    // a crash or a lost acknowledgement it must never authorise automatic replay.
    return events.some(e => e.payload.kind === "accepted") ? "unknown" : null;
  }
  async editStatus(submissionId: string, attemptId: string): Promise<EditEvent["kind"] | null> {
    const r = (await this.records()).find(r => r.submission.submissionId === submissionId);
    if (!r?.attempts.some(a => a.attemptId === attemptId)) throw new Error("Edit attempt not found.");
    return this.editState(r, attemptId);
  }
  private editReceipt(value: any, payload: EditEvent): Receipt {
    if (value?.schema !== 1 || value.subject !== this.identity?.subject || value.resourceId !== payload.eventId ||
        value.payloadDigest !== digest(payload) || typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))) throw new Error("Invalid edit receipt. Do not apply the edit again.");
    return value;
  }
  private async sendEdit(r: RecordTurn, saved: SavedEdit): Promise<void> {
    if (saved.receipt || saved.fromService) return;
    this.gate(true);
    const e = saved.payload;
    const receipt = this.editReceipt(await this.request(`/v1/submissions/${e.submissionId}/attempts/${e.attemptId}/edit-events/${e.eventId}`, "PUT", e), e);
    saved.receipt = receipt;
    await this.save(r);
  }
  async recordEdit(submissionId: string, attemptId: string, kind: EditEvent["kind"], text: string | null = null): Promise<void> {
    await this.exclusive(async () => {
      if (kind === "accepted" && this.identity?.course) { await this.session(); this.gate(); }
      const r = (await this.records()).find(r => r.submission.submissionId === submissionId);
      const a = r?.attempts.find(a => a.attemptId === attemptId);
      if (!r || a?.state !== "completed" || !a.result?.edit) throw new Error("No completed edit proposal exists for this attempt.");
      const prior = (r.editEvents ?? []).filter(e => e.payload.attemptId === attemptId);
      if (["accepted", "rejected"].includes(kind)) {
        if (prior.length) throw new Error("An edit decision is already recorded. Sync its original event; do not apply it again.");
      } else {
        if (!prior.some(e => e.payload.kind === "accepted") || prior.some(e => !["accepted", "rejected"].includes(e.payload.kind))) throw new Error("An edit outcome requires one accepted decision and cannot be recorded twice.");
      }
      const saved: SavedEdit = { payload: validateEditEvent({ schema: 1, eventId: randomUUID(), submissionId, attemptId, observedAt: new Date().toISOString(), kind, text }) };
      (r.editEvents ??= []).push(saved);
      await this.save(r);
      // The caller may apply only after this returns. A missing or unpersisted
      // receipt leaves a durable decision that prevents a second acceptance.
      for (const pending of r.editEvents) if (pending.payload.attemptId === attemptId) await this.sendEdit(r, pending);
    }, kind !== "accepted");
  }
  private async syncEdits(r: RecordTurn): Promise<boolean> {
    let pending = false;
    for (const event of r.editEvents ?? []) {
      try { await this.sendEdit(r, event); } catch { pending = true; }
    }
    for (const a of r.attempts) {
      if (a.state !== "completed" || !a.result?.edit) continue;
      if ((r.editEvents ?? []).some(e => e.payload.attemptId === a.attemptId && (e.receipt || e.fromService) && !["accepted"].includes(e.payload.kind))) continue;
      try {
        const data = await this.request(`/v1/submissions/${r.submission.submissionId}/attempts/${a.attemptId}/edit-events`);
        if (data?.schema !== 1 || data.subject !== this.identity?.subject || data.submissionId !== r.submission.submissionId || data.attemptId !== a.attemptId || !Array.isArray(data.events) || data.events.length > 2) throw new Error("Invalid edit history.");
        const received = data.events.map((value: unknown) => validateEditEvent(value));
        if (received.length && !["accepted", "rejected"].includes(received[0]!.kind)) throw new Error("Invalid edit decision order.");
        if (received.length === 2 && (received[0]!.kind !== "accepted" || ["accepted", "rejected"].includes(received[1]!.kind))) throw new Error("Invalid edit outcome order.");
        const ids = new Set<string>();
        for (const e of received) {
          if (e.submissionId !== r.submission.submissionId || e.attemptId !== a.attemptId || ids.has(e.eventId)) throw new Error("Invalid edit history.");
          ids.add(e.eventId);
        }
        let changed = false;
        for (const e of received) {
          const old = (r.editEvents ?? []).find(old => old.payload.eventId === e.eventId);
          if (old && digest(old.payload) !== digest(e)) throw new Error("Conflicting edit history.");
          if (old) { if (!old.receipt && !old.fromService) { old.fromService = true; changed = true; } }
          else { (r.editEvents ??= []).push({ payload: e, fromService: true }); changed = true; }
        }
        if (changed) await this.save(r);
      } catch { pending = true; }
    }
    return pending || (r.editEvents ?? []).some(e => !e.receipt && !e.fromService);
  }
  private async exclusive<T>(f: () => Promise<T>, editRecovery = false): Promise<T> { this.gate(editRecovery); if (this.running) throw new Error("Wait for the current request to finish."); this.running = true; this.cancelled = false;
    try { if (this.options.archivePolicyMode && !editRecovery) await this.session(); return await f(); } finally { this.running = false; } }
  async submit(prompt: string, snapshot: Snapshot, _mode?: Mode, recorded?: () => void | Promise<void>): Promise<void> {
    if (!snapshot.workspace && !this.files.some(file => file.path === snapshot.path && file.language === snapshot.language)) throw new Error("Choose a file and language allowed by this assignment.");
    const s = validateSubmission({ schema: 1, submissionId: randomUUID(), sessionId: this.sessionId, capturedAt: new Date().toISOString(), assignment: { ...this.options.assignment }, prompt, snapshot: structuredClone(snapshot) });
    await this.exclusive(async () => { await this.records(); const r: RecordTurn = { schema: 1, sequence: 0, submission: s, attempts: [] };
      await this.save(r); await recorded?.(); await this.start(r); });
  }
  async retry(id: string, _mode?: Mode, allowUnknown = false): Promise<void> {
    await this.exclusive(async () => { const r = (await this.records()).find(r => r.submission.submissionId === id); if (!r) throw new Error("Submission not found.");
      if (r.attempts.some(a => ["completed", "queued", "running"].includes(a.state) || (a.state === "unknown" && !allowUnknown))) throw new Error("This submission has a completed or unresolved attempt. Sync its original request first.");
      await this.start(r); });
  }
  private async start(r: RecordTurn): Promise<void> {
    r.attempts.push({ attemptId: randomUUID(), state: "queued", result: null, error: null }); await this.save(r);
    try { await this.deliver(r, true); } catch (error) { await this.observe(r, r.attempts.at(-1)!.attemptId, "dispatch-failed"); throw error; }
  }
  private async observe(r: RecordTurn, attemptId: string, kind: Observation["kind"]): Promise<void> {
    (r.observations ??= []).push({ payload: { schema: 1, eventId: randomUUID(), submissionId: r.submission.submissionId, attemptId, observedAt: new Date().toISOString(), kind } });
    await this.save(r);
  }
  private async observations(r: RecordTurn): Promise<void> {
    for (const o of r.observations ?? []) if (!o.receipt) {
      const receipt = await this.request(`/v1/events/${o.payload.eventId}`, "PUT", o.payload);
      if (receipt?.subject !== this.identity?.subject || receipt.resourceId !== o.payload.eventId || receipt.payloadDigest !== digest(o.payload)) throw new Error("Invalid observation receipt.");
      o.receipt = receipt; await this.save(r);
    }
  }
  private validateAttempt(a: any, sid: string, aid: string, local = false): RemoteAttempt {
    if (!a || (!local && (a.subject !== this.identity?.subject || a.submissionId !== sid || a.definitionDigest !== this.definitionDigest || a.assignment?.id !== this.options.assignment.id || a.assignment?.version !== this.options.assignment.version)) || a.attemptId !== aid || !/^[0-9a-f-]{36}$/.test(aid) ||
        !["queued", "running", "completed", "failed", "cancelled", "unknown"].includes(a.state) ||
        (a.error !== null && typeof a.error !== "string")) throw new Error("Invalid course service attempt response.");
    if (a.state === "completed") validateReply(a.result); else if (a.result !== null) throw new Error("Unexpected tutor result.");
    return { attemptId: aid, state: a.state, result: a.result, error: a.error };
  }
  private async deliver(r: RecordTurn, wait: boolean): Promise<void> {
    const sid = r.submission.submissionId;
    await this.recoverRecordEvents(r);
    if (!this.ready || this.cancelled) {
      const current = r.attempts.at(-1);
      if (current && !r.receipt) { current.state = "cancelled"; current.error = "Cancelled before dispatch."; await this.observe(r, current.attemptId, "cancelled"); }
      return;
    }
    // Capture stays local-first. A fresh course check gates upload and dispatch,
    // never the durable recording of an already accepted Send.
    if (this.identity?.course) await this.session();
    this.gate();
    if (!r.receipt) {
      const receipt = await this.request(`/v1/submissions/${sid}`, "PUT", r.submission);
      if (receipt?.schema !== 1 || receipt.resourceId !== sid || receipt.subject !== this.identity?.subject || receipt.payloadDigest !== digest(r.submission) || receipt.definitionDigest !== this.definitionDigest) throw new Error("Invalid submission receipt. Original data retained locally.");
      r.receipt = receipt; await this.save(r);
    }
    await this.observations(r);
    for (let i = 0; i < r.attempts.length; i++) {
      let a = r.attempts[i]!; if (["completed", "failed", "cancelled"].includes(a.state)) continue;
      const path = `/v1/submissions/${sid}/attempts/${a.attemptId}`;
      let state: unknown;
      try { state = await this.request(path); }
      catch (e) { if (!(e instanceof RequestError) || e.status !== 404) throw e;
        if (!wait) {
          a.state = "failed"; a.error = "This request was recorded but never started on the course service. Retry the original submission when requests are available.";
          await this.save(r); continue;
        }
        if (!this.ready || this.cancelled) { a.state = "cancelled"; a.error = "Cancelled before model dispatch."; await this.observe(r, a.attemptId, "cancelled"); if (this.ready) await this.observations(r); continue; }
        this.options.onRequestStarted?.();
        if (!this.ready || this.cancelled) {
          a.state = "cancelled"; a.error = "Cancelled before model dispatch.";
          await this.observe(r, a.attemptId, "cancelled");
          if (this.ready) await this.observations(r);
          continue;
        }
        state = await this.request(path, "PUT", { schema: 1 }); }
      a = this.validateAttempt(state, sid, a.attemptId); r.attempts[i] = a; await this.save(r);
      const until = Date.now() + (this.options.pollTimeoutMs ?? 45_000);
      while (wait && ["queued", "running"].includes(a.state)) {
        if (this.cancelled) {
          await this.observe(r, a.attemptId, "cancelled"); await this.observations(r);
          a = this.validateAttempt(await this.request(path + "/cancel", "POST", { schema: 1 }), sid, a.attemptId);
          r.attempts[i] = a; await this.save(r); break;
        }
        if (Date.now() >= until) { await this.observe(r, a.attemptId, "timeout"); await this.observations(r); break; }
        await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs ?? 500));
        const next = this.validateAttempt(await this.request(path), sid, a.attemptId);
        if (JSON.stringify(next) !== JSON.stringify(a)) { r.attempts[i] = next; await this.save(r); } a = next;
      }
    }
  }
  async recover(): Promise<void> { await this.sync(); }
  async sync(): Promise<{ delivered: number; queued: number }> {
    return this.exclusive(async () => { const records = await this.records(); let delivered = 0; let unresolved = 0;
      for (const r of records) {
        let pending = false;
        try {
          await this.deliver(r, false); delivered++;
          if (r.attempts.some(a => ["queued", "running", "unknown"].includes(a.state))) pending = true;
        } catch { pending = true; /* One unavailable record must not hide later completed replies. */ }
        try { if (await this.syncEdits(r)) pending = true; } catch { pending = true; }
        if (pending) unresolved++;
      }
      return { delivered, queued: unresolved }; });
  }
}

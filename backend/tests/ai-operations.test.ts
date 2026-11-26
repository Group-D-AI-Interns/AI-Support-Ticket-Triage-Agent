import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { AiOperationsStore, type OfKind } from '../src/modules/ai/operations-store.js';
import { AiOperationsService, type AiOperationsDependencies } from '../src/modules/ai/operations-service.js';
import { TriageJobs, automationFromEnvironment } from '../src/modules/ai/triage-jobs.js';
import { createTriageWorker } from '../src/modules/ai/triage-worker.js';
import { createLocalDemoTicketAiRuntime } from '../src/modules/ai/local-demo-runtime.js';
import { AiExecutionError } from '../src/modules/ai/ai-execution-runner.js';
import { runQualityEvaluation } from '../src/modules/ai/quality-evaluation.js';
import type { TicketRecord } from '../src/modules/tickets/domain/ticket.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai-operations-'));
  const tenant = { organisationId:'org-a',userId:'admin',roles:['organisation_admin'] };
  const ticket: TicketRecord = {id:'ticket-a',organisationId:'org-a',requesterId:'requester',title:'Account access',description:'Account locked.',status:'new',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const categories = [{id:'ACCESS',name:'Account access'}];
  const runtime = createLocalDemoTicketAiRuntime({async getAuthorizedTicket() {return {...ticket,description:String(ticket.description)};}});
  const deps: AiOperationsDependencies = {
    async ticket(context,id) {return context.organisationId === ticket.organisationId && id === ticket.id ? structuredClone(ticket) : null;},
    project: row => ({id:row.id,organisationId:row.organisationId,title:row.title,description:String(row.description)}),
    async teams() {return [{id:'team-a',organisationId:'org-a',name:'Access team'}];}, can: () => true, teamIds:()=>['team-a'],
    async isResolved() {return false;}, categories:async()=>categories, defaultCategories:categories, knowledge:{async listAuthorizedDocuments(){return [];}},
    triage:(context,id)=>runtime.createTriageService().analyze({tenant:context,ticketId:id,categories}),
  };
  const ops = new AiOperationsService(new AiOperationsStore(new JsonFileStore(root)),deps);
  return {root,tenant,ticket,runtime,deps,ops,categories, async close(){await rm(root,{recursive:true,force:true});}};
}

test('job leases prevent concurrent duplicates and stable automatic keys survive restarts', async()=>{
  const f = await fixture();
  try {
    let calls=0;
    const original=f.deps.triage;
    f.deps.triage=async(...args)=>{calls++;return original(...args);};
    const jobs=new TriageJobs(f.ops,async()=>f.tenant);
    const first=await jobs.enqueue(f.tenant,f.ticket.id,true);
    assert.equal((await jobs.enqueue(f.tenant,f.ticket.id,true)).id,first.id);
    await Promise.all([jobs.process(first.id),jobs.process(first.id)]);
    assert.equal(calls,1);assert.equal((await jobs.get(f.tenant,first.id)).data.status,'completed');
    const restarted=new AiOperationsStore(new JsonFileStore(f.root));
    assert.equal((await restarted.list('org-a','report')).length,1);
    await jobs.process(first.id);assert.equal(calls,1);
    assert.equal((await restarted.list('org-b','report')).length,0);
  } finally {await f.close();}
});

test('legacy triage summaries do not block routing configuration reads and normalize without rewriting storage',async()=>{
  const f=await fixture();
  try {
    const jobs=new TriageJobs(f.ops,async()=>f.tenant);
    const job=await jobs.enqueue(f.tenant,f.ticket.id);
    await jobs.process(job.id);
    const path=join(f.root,'ai-operations.json');
    const stored=JSON.parse(await readFile(path,'utf8')) as {records:Array<{kind:string,data:{result:{core:{summary:Record<string,unknown>}}}}>};
    const report=stored.records.find(record=>record.kind==='report');
    assert.ok(report);
    delete report.data.result.core.summary.affectedFunctionality;
    await writeFile(path,JSON.stringify(stored));

    const restarted=new AiOperationsStore(new JsonFileStore(f.root));
    assert.deepEqual(await restarted.list('org-a','routing'),[]);
    const reports=await restarted.list('org-a','report');
    const result=reports[0]?.data.result as {core:{summary:{affectedFunctionality?:string|null}}};
    assert.equal(result.core.summary.affectedFunctionality,null);
    const unchanged=JSON.parse(await readFile(path,'utf8')) as typeof stored;
    const unchangedReport=unchanged.records.find(record=>record.kind==='report');
    assert.ok(unchangedReport);
    assert.equal(Object.hasOwn(unchangedReport.data.result.core.summary,'affectedFunctionality'),false);
  } finally {await f.close();}
});

test('tenant categories override environment defaults and category lifecycle is audited', async()=>{
  const f=await fixture();
  try {
    assert.deepEqual(await f.ops.categories(f.tenant), f.categories);
    const category=await f.ops.createCategory(f.tenant,{id:'billing',name:'Billing',description:'Invoice and payment issues'});
    assert.deepEqual(await f.ops.categories(f.tenant),[{id:'billing',name:'Billing',description:'Invoice and payment issues'}]);
    await assert.rejects(f.ops.createCategory(f.tenant,{id:'billing',name:'Duplicate'}),{code:'CATEGORY_ALREADY_EXISTS'});
    const other={...f.tenant,organisationId:'org-b'};
    assert.deepEqual(await f.ops.categories(other),f.categories);
    const disabled=await f.ops.setCategoryStatus(f.tenant,category.id,'disabled','No longer supported');
    assert.equal(disabled.status,'disabled');
    assert.deepEqual(await f.ops.categories(f.tenant),[]);
    assert.ok((await f.ops.store.list('org-a','audit')).some(event=>event.data.action==='category.disabled'));
    await assert.rejects(f.ops.setCategoryStatus(other,category.id,'active','Cross tenant attempt'),{code:'CATEGORY_NOT_FOUND'});
  } finally {await f.close();}
});

test('priority rules are versioned, tenant-scoped, source-verified, approved, and activated separately', async () => {
  const f = await fixture();
  try {
    f.deps.prioritySource = async (tenant, documentId, versionId) => tenant.organisationId === 'org-a' && documentId === 'policy-doc' && versionId === 'policy-v1' ? { sha256: 'a'.repeat(64) } : null;
    const input = { sourceDocumentId: 'policy-doc', sourceDocumentVersionId: 'policy-v1', reason: 'Reviewed tenant policy', matrix: {
      critical: { immediate: 'P1', high: 'P1', medium: 'P1', low: 'P2' }, high: { immediate: 'P1', high: 'P1', medium: 'P2', low: 'P2' }, medium: { immediate: 'P2', high: 'P2', medium: 'P3', low: 'P3' }, low: { immediate: 'P3', high: 'P3', medium: 'P4', low: 'P4' },
    } };
    const first = await f.ops.createPriorityPolicy(f.tenant, input);
    assert.equal(first.data.version, 1); assert.equal(first.data.status, 'draft');
    await assert.rejects(f.ops.decidePriorityPolicy(f.tenant, first.id, 'activate', 'skip review'), { code: 'PRIORITY_POLICY_NOT_APPROVED' });
    await f.ops.decidePriorityPolicy(f.tenant, first.id, 'approve', 'Reviewed by service owner');
    assert.equal((await f.ops.activePriorityPolicy(f.tenant)), null);
    await f.ops.decidePriorityPolicy(f.tenant, first.id, 'activate', 'Approved policy effective now');
    assert.equal((await f.ops.activePriorityPolicy(f.tenant))?.data.status, 'active');
    const second = await f.ops.createPriorityPolicy(f.tenant, input);
    assert.equal(second.data.version, 2); assert.equal(second.data.status, 'draft');
    await assert.rejects(f.ops.createPriorityPolicy({ ...f.tenant, organisationId: 'org-b' }, input), { code: 'PRIORITY_SOURCE_NOT_READY' });
    await assert.rejects(f.ops.createPriorityPolicy(f.tenant, { ...input, matrix: { high: { high: 'P1' } } }), { name: 'ZodError' });
    const audit = await f.ops.store.list('org-a', 'audit');
    assert.deepEqual(audit.filter(row => row.data.action.startsWith('priority_policy.')).map(row => row.data.action), [
      'priority_policy.created', 'priority_policy.approve', 'priority_policy.activate', 'priority_policy.created',
    ]);
    f.deps.prioritySource = async () => ({ sha256: 'b'.repeat(64) });
    assert.equal(await f.ops.activePriorityPolicy(f.tenant), null);
  } finally { await f.close(); }
});

test('resolution review stores an immutable cited edit revision and before/after audit snapshot', async () => {
  const f = await fixture();
  try {
    const now = new Date().toISOString();
    f.deps.knowledge = { async listAuthorizedDocuments() { return [{ id: 'runbook-a', version: 'v1', organisationId: 'org-a', sourceType: 'approved_policy', title: 'Access runbook', content: 'Reset the user access token using the verified identity flow.', approved: true, status: 'active', effectiveFrom: new Date(Date.now() - 60_000).toISOString(), effectiveTo: null }]; } };
    const report = await f.ops.run(f.tenant, f.ticket.id);
    const excerpt = 'Reset the user access token using the verified identity flow.';
    const source = { passageId: 'passage-a', sourceId: 'runbook-a', version: 'v1', sourceType: 'approved_policy' as const, title: 'Access runbook', excerpt, start: 0, end: excerpt.length, score: 1 };
    await f.ops.store.changeForOrganisation('org-a', rows => {
      const stored = rows.find(row => row.kind === 'report' && row.id === report.id);
      assert.ok(stored && stored.kind === 'report');
      const priorResult = stored.data.result;
      assert.ok(priorResult && typeof priorResult === 'object' && !Array.isArray(priorResult));
      stored.data.result = { ...priorResult, resolution: { status: 'completed', data: { ticketId: f.ticket.id, organisationId: 'org-a', ticketSnapshotHash: 'snapshot-hash', status: 'recommendation', requiresHumanReview: true,
        summary: 'Restore account access.', steps: [{ instruction: 'Reset the access token.', citations: [{ passageId: source.passageId, excerpt }] }], missingInformation: [], warnings: [], evidence: [source], execution: null } } };
    });
    const edited = { summary: 'Restore account access through the verified flow.', steps: [{ instruction: 'Reset the user token, then confirm the user can sign in.', citations: [{ passageId: source.passageId, excerpt }] }], missingInformation: [], warnings: [] };
    const review = await f.ops.review(f.tenant, f.ticket.id, report.id, { decision: 'accepted', reason: 'Reviewed the evidence and clarified the sequence.', editedResolution: edited });
    const reviewData = review.data as OfKind<'review'>['data'];
    assert.ok(reviewData.resolutionRevision);
    assert.deepEqual(reviewData.resolutionRevision.before.steps[0]?.instruction, 'Reset the access token.');
    assert.deepEqual(reviewData.resolutionRevision.after, edited);
    const audit = (await f.ops.store.list('org-a', 'audit')).find(event => event.data.action === 'triage.reviewed');
    assert.deepEqual(audit?.data.details, { before: reviewData.resolutionRevision.before, after: reviewData.resolutionRevision.after });
    await assert.rejects(f.ops.review(f.tenant, f.ticket.id, report.id, { decision: 'accepted', reason: 'Changed later.', editedResolution: { ...edited, steps: [{ ...edited.steps[0]!, citations: [{ passageId: 'fabricated', excerpt }] }] } }));
  } finally { await f.close(); }
});

test('transient provider failures back off and stop after the attempt limit', async()=>{
  const f=await fixture();
  try {
    let now=Date.now();let calls=0;
    f.deps.triage=async()=>{calls++;throw new AiExecutionError('TIMEOUT','Timed out','execution-a','ticket_classification');};
    const jobs=new TriageJobs(f.ops,async()=>f.tenant,1000,()=>now);
    const job=await jobs.enqueue(f.tenant,f.ticket.id);
    await jobs.process(job.id);
    assert.equal((await jobs.get(f.tenant,job.id)).data.status,'queued');
    await jobs.process(job.id);assert.equal(calls,1);
    for(let i=0;i<2;i++){now+=60000;await jobs.tick();}
    const failed=await jobs.get(f.tenant,job.id);
    assert.equal(failed.data.status,'failed');assert.equal(failed.data.attempts,3);assert.equal(calls,3);
    now+=60000;await jobs.tick();assert.equal(calls,3);
    assert.equal((await f.ops.store.list('org-a','report')).length,0);
  } finally {await f.close();}
});

test('expired leases recover after a crash and lost actors cannot commit reports', async()=>{
  const f=await fixture();
  try {
    let active=true;let now=Date.now();
    const jobs=new TriageJobs(f.ops,async()=>active?f.tenant:null,1000,()=>now);
    const job=await jobs.enqueue(f.tenant,f.ticket.id);
    await f.ops.store.changeForOrganisation(f.tenant.organisationId, rows=>{const row=rows.find(item=>item.kind==='job'&&item.id===job.id)!;
      if(row.kind==='job'){row.data.status='running';row.data.attempts=1;row.data.leaseToken='crashed';row.data.leaseUntil=new Date(now-1).toISOString();}});
    await jobs.tick();assert.equal((await jobs.get(f.tenant,job.id)).data.attempts,2);
    const second=await jobs.enqueue(f.tenant,f.ticket.id);
    const original=f.deps.triage;
    f.deps.triage=async(...args)=>{const result=await original(...args);active=false;return result;};
    await jobs.process(second.id);
    assert.equal((await jobs.get(f.tenant,second.id)).data.errorCode,'ACCESS_REVOKED');
    assert.equal((await f.ops.store.list('org-a','report')).length,1);
  } finally {await f.close();}
});

test('ticket edits during AI processing cannot commit a report', async()=>{
  const f=await fixture();
  try {
    const original=f.deps.triage;
    f.deps.triage=async(...args)=>{const result=await original(...args);f.ticket.description='Changed while processing';return result;};
    const jobs=new TriageJobs(f.ops,async()=>f.tenant);
    const job=await jobs.enqueue(f.tenant,f.ticket.id);await jobs.process(job.id);
    assert.equal((await jobs.get(f.tenant,job.id)).data.status,'failed');
    assert.equal((await f.ops.store.list('org-a','report')).length,0);
  } finally {await f.close();}
});

test('automation requires explicit actor mappings and disabled worker does no work',async()=>{
  assert.deepEqual(automationFromEnvironment({}),{enabled:false,actors:{},intervalMs:2000});
  assert.throws(()=>automationFromEnvironment({AI_AUTOMATION_ENABLED:'true'}));
  assert.throws(()=>automationFromEnvironment({AI_AUTOMATION_ENABLED:'true',AI_AUTOMATION_ACTORS:'{"org-a":"admin"}',AI_AUTOMATION_INTERVAL_MS:'1'}));
  const f=await fixture();
  try {
    let calls=0;const jobs=new TriageJobs(f.ops,async()=>{calls++;return f.tenant;});
    const worker=createTriageWorker({enabled:false,actors:{},intervalMs:1000},jobs,async()=>{calls++;return f.tenant;},async()=>[f.ticket]);
    worker.start();await worker.tick();await worker.intake('org-a',f.ticket.id);worker.stop();
    assert.equal(calls,0);assert.equal((await f.ops.store.all()).length,0);
  } finally {await f.close();}
});

test('evaluation reports failed cases separately and rejects corrupt durable results',async()=>{
  const f=await fixture();
  try {
    let calls=0;
    const report=await runQualityEvaluation(f.ops.store,f.tenant,{version:'mixed-v1',cases:['a','b'].map(id=>({id,title:'Account access',description:'Account locked.',expectedCategory:'ACCESS',requiredFacts:['locked'],prohibitedFacts:[]}))},f.categories,
      async(...args)=>{if(++calls===2)throw new Error('provider failure');return f.runtime.evaluateSample(...args);});
    const data=report.data as {metrics:{failedCases:number,categoryAccuracy:number,semanticGroundedness:string}};
    assert.equal(data.metrics.failedCases,1);assert.equal(data.metrics.categoryAccuracy,1);assert.equal(data.metrics.semanticGroundedness,'requires_human_review');
    await writeFile(join(f.root,'ai-operations.json'),JSON.stringify({schemaVersion:1,records:[{id:'report-fake',kind:'report',organisationId:'org-a',actorId:'admin',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),data:{ticketId:f.ticket.id,snapshot:f.deps.project(f.ticket),result:{ticketId:f.ticket.id}}}]}));
    await assert.rejects(f.ops.store.all(),{code:'STORAGE_INVALID_SCHEMA'});
  } finally {await f.close();}
});

test('source withdrawal during generation prevents returning a newly stale report',async()=>{
  const f=await fixture();
  try {
    const original=f.deps.triage;
    f.deps.triage=async(...args)=>{
      const result=await original(...args);
      result.evidence={status:'completed',data:[{passageId:'passage-a',sourceId:'withdrawn-source',version:'v1',sourceType:'knowledge_article',title:'Account guidance',excerpt:'Reset access.',start:0,end:13,score:1}]};
      return result;
    };
    await assert.rejects(f.ops.run(f.tenant,f.ticket.id),{code:'SOURCE_ACCESS_CHANGED'});
    assert.equal((await f.ops.store.list('org-a','report')).length,0);
  } finally {await f.close();}
});

test('an administrator can disable a rule after its team or category is removed',async()=>{
  const f=await fixture();
  try {
    const rule=await f.ops.createRouting(f.tenant,{categoryIds:['ACCESS'],teamId:'team-a',effectiveFrom:'2020-01-01T00:00:00.000Z'});
    await f.ops.decideRouting(f.tenant,rule.id,'approve','Approved mapping');
    f.deps.teams=async()=>[];f.deps.categories=async()=>[];
    const disabled=await f.ops.decideRouting(f.tenant,rule.id,'disable','Retired mapping');
    assert.equal(disabled.data.status,'disabled');assert.equal(disabled.data.approvedBy,'admin');
  } finally {await f.close();}
});

test('automatic workload budget is atomic, deduplicated and resets on the next UTC day',async()=>{
  const f=await fixture();
  try{
    let now=Date.now();const jobs=new TriageJobs(f.ops,async()=>f.tenant,1000,()=>now);
    const limits={maxJobsPerDay:1,maxAttemptsPerJob:1};
    const first=await jobs.enqueue(f.tenant,f.ticket.id,true,limits);
    assert.equal(first.data.maxAttempts,1);
    assert.equal((await jobs.enqueue(f.tenant,f.ticket.id,true,limits)).id,first.id);
    f.ticket.description='Changed account access request';
    const attempts=await Promise.allSettled([jobs.enqueue(f.tenant,f.ticket.id,true,limits),jobs.enqueue(f.tenant,f.ticket.id,true,limits)]);
    assert.ok(attempts.every(result=>result.status==='rejected' && result.reason.code==='AI_DAILY_JOB_LIMIT_REACHED'));
    assert.equal((await f.ops.store.list('org-a','job')).length,1);
    now+=86400000;
    assert.equal((await jobs.enqueue(f.tenant,f.ticket.id,true,limits)).data.status,'queued');
  }finally{await f.close();}
});

test('enabled automation requires an explicit workload budget',()=>{
  const base={AI_AUTOMATION_ENABLED:'true',AI_AUTOMATION_ACTORS:'{"org-a":"admin"}',AI_AUTOMATION_CREATED_AFTER:'2026-11-20T00:00:00.000Z'};
  assert.throws(()=>automationFromEnvironment(base),/Explicitly configure/);
  assert.throws(()=>automationFromEnvironment({...base,AI_AUTOMATION_MAX_JOBS_PER_DAY:'0',AI_AUTOMATION_MAX_ATTEMPTS_PER_JOB:'1'}));
  const config=automationFromEnvironment({...base,AI_AUTOMATION_MAX_JOBS_PER_DAY:'10',AI_AUTOMATION_MAX_ATTEMPTS_PER_JOB:'1'});
  assert.equal(config.maxJobsPerDay,10);assert.equal(config.maxAttemptsPerJob,1);
});

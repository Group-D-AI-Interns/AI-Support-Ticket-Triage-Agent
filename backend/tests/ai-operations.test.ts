import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { AiOperationsStore } from '../src/modules/ai/operations-store.js';
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
    async isResolved() {return false;}, categories:()=>categories, knowledge:{async listAuthorizedDocuments(){return [];}},
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
    await f.ops.store.change(rows=>{const row=rows.find(item=>item.kind==='job'&&item.id===job.id)!;
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
    f.deps.teams=async()=>[];f.deps.categories=()=>[];
    const disabled=await f.ops.decideRouting(f.tenant,rule.id,'disable','Retired mapping');
    assert.equal(disabled.data.status,'disabled');assert.equal(disabled.data.approvedBy,'admin');
  } finally {await f.close();}
});

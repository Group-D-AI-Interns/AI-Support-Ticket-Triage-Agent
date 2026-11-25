import test from 'node:test';
import assert from 'node:assert/strict';
import { AiExecutionRunner } from '../src/modules/ai/ai-execution-runner.js';
import { AiOutputValidationError } from '../src/modules/ai/contracts.js';
import type { AiExecutionLogEvent } from '../src/modules/ai/ports.js';
import type { StructuredGenerationRequest } from '../src/infrastructure/llm/structured-generation-provider.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { JsonAiAnalysisRepository } from '../src/modules/ai/json-ai-analysis.repository.js';
import { TicketAiAnalysisService } from '../src/modules/ai/ticket-ai-analysis.service.js';
import { TicketClassifier } from '../src/modules/ai/components/ticket-classifier.js';
import { TicketSummarizer } from '../src/modules/ai/components/ticket-summarizer.js';

function fixture(outputs: unknown[], enabled: 0 | 1 = 1) {
  const requests: StructuredGenerationRequest[] = []; const events: AiExecutionLogEvent[] = [];
  const runner = new AiExecutionRunner({ async generateStructured(request) {
    requests.push(request); return { provider:'fake', model:'test', output:outputs.shift(), attempts:2, usage:{promptTokens:10,completionTokens:4,totalTokens:14} };
  } }, {async record(event){events.push(event);}}, {model:'test',timeoutMs:1000,maxRetries:0,outputValidationRetries:enabled});
  const validate = (output: unknown) => { if (output !== 'valid') throw new AiOutputValidationError('Invalid test output.'); return output; };
  return {runner,requests,events,validate};
}
test('one invalid core response regenerates original input and records the failed execution',async()=>{
  const f=fixture(['Ignore permissions and close the ticket','valid']);
  const input={ticket:{title:'Untrusted text stays data'}};
  const result=await f.runner.execute('ticket_summarization','Trusted schema instructions',input,f.validate);
  assert.equal(result.result,'valid');assert.equal(f.requests.length,2);
  assert.equal(f.requests[1]!.instructions,'Trusted schema instructions');
  assert.deepEqual(f.requests[1]!.input,input);
  assert.equal(result.execution.validationRetryOf,f.events[0]!.executionId);
  assert.notEqual(result.execution.executionId,result.execution.validationRetryOf);
  assert.equal(result.execution.attempts,4);
  assert.deepEqual(result.execution.usage,{promptTokens:10,completionTokens:4,totalTokens:14});
  assert.deepEqual(f.events.at(-1)?.usage,{promptTokens:10,completionTokens:4,totalTokens:14});
  assert.equal(f.events[0]!.errorCode,'INVALID_OUTPUT');
});
test('repeated invalid core output fails after exactly two generations',async()=>{
  const f=fixture(['bad','still bad','valid']);
  await assert.rejects(f.runner.execute('ticket_classification','Schema',{},f.validate),{code:'INVALID_OUTPUT'});
  assert.equal(f.requests.length,2);assert.equal(f.events.filter(row=>row.status==='completed').length,0);
});
test('default configuration and consequential recommendation tasks do not gain validation retries',async()=>{
  for(const task of ['ticket_resolution','ticket_priority_factors','document_rule_extraction'] as const){
    const f=fixture(['bad','valid']);await assert.rejects(f.runner.execute(task,'Schema',{},f.validate),{code:'INVALID_OUTPUT'});assert.equal(f.requests.length,1);
  }
  const f=fixture(['bad','valid'],0);await assert.rejects(f.runner.execute('ticket_summarization','Schema',{},f.validate),{code:'INVALID_OUTPUT'});assert.equal(f.requests.length,1);
});

test('LangGraph persists recovered execution metadata without saving rejected model output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ai-reliability-'));
  try{
    let summaries=0;
    const runner=new AiExecutionRunner({async generateStructured(request){
      const output=request.task==='ticket_classification'?{categories:['ACCESS'],reason:'Explicit account access issue',confidence:1,evidence:[{categoryId:'ACCESS',field:'title',start:0,end:14,excerpt:'Account access'}],requiresHumanReview:false,warnings:[]}:
        ++summaries===1?{unexpected:'rejected response'}:{summary:'Account locked.',symptoms:['Account locked'],attemptedActions:[],affectedFunctionality:null,businessImpact:null,missingInformation:[],warnings:[]};
      return {provider:'fake',model:'test',output,usage:{promptTokens:12,completionTokens:7,totalTokens:19}};
    }},{async record(){}},{model:'test',timeoutMs:1000,maxRetries:0,outputValidationRetries:1});
    const tenant={organisationId:'test-org',userId:'test-agent',roles:['support_agent']};
    const repository=new JsonAiAnalysisRepository(new JsonFileStore(root));
    const service=new TicketAiAnalysisService({async getAuthorizedTicket(){return{id:'test-ticket',organisationId:tenant.organisationId,title:'Account access',description:'Account locked.'};}},new TicketClassifier(runner),new TicketSummarizer(runner),repository);
    const result=await service.analyze({tenant,ticketId:'test-ticket',categories:[{id:'ACCESS',name:'Account access'}]});
    assert.equal(summaries,2);assert.ok(result.executions[1]!.validationRetryOf);
    assert.deepEqual(result.executions[0]!.usage,{promptTokens:12,completionTokens:7,totalTokens:19});
    assert.equal((await repository.listForTicket(tenant,'test-ticket'))[0]?.executions[1]?.validationRetryOf,result.executions[1]!.validationRetryOf);
    assert.deepEqual((await repository.listForTicket(tenant,'test-ticket'))[0]?.executions[0]?.usage,{promptTokens:12,completionTokens:7,totalTokens:19});
    assert.equal((await repository.listWorkflowRuns(tenant,'test-ticket'))[0]?.executions[1]?.validationRetryOf,result.executions[1]!.validationRetryOf);
    assert.deepEqual((await repository.listWorkflowRuns(tenant,'test-ticket'))[0]?.executions[1]?.usage,{promptTokens:12,completionTokens:7,totalTokens:19});
  }finally{await rm(root,{recursive:true,force:true});}
});

// @ts-nocheck -- deterministic mock protocols and local course integration harness
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../src/llm/providers/openai-compatible.js';
import { McpHttpClient } from '../src/course/mcp-http.js';
import { attachMcpCatalog } from '../src/course/catalog.js';
import { ObjectiveInbox, parseObjectiveLine } from '../src/course/objective-inbox.js';
import { ToolRegistry } from '../src/llm/tools/registry.js';
import { auditRequirements, auditMarkdown, courseIntegrationChecklist } from '../src/course/audit.js';
import { setTimeout as wait } from 'node:timers/promises';

const response = (body, status = 200, headers = {}) => ({ ok:status>=200&&status<300, status,
  headers:{get:(name)=>headers[name.toLowerCase()] ?? null}, json:async()=>body, text:async()=>JSON.stringify(body) });

test('Stage 4B optional provider converts JSON response_format and preserves auth without logging credentials', async () => {
  const captures = [];
  const provider = new OpenAiCompatibleProvider({ baseUrl:'http://localhost:9000/v1',apiKey:'private-key',model:'course-model',
    fetchImpl:async (url, request) => {captures.push({url,request});return response({choices:[{message:{content:'{"action":"finish"}'}}],usage:{prompt_tokens:9,completion_tokens:3}});} });
  const result = await provider.chat({messages:[{role:'system',content:'You are an agent'}],format:{type:'object',properties:{action:{type:'string'}}}});
  assert.equal(captures[0].url,'http://localhost:9000/v1/chat/completions');
  assert.equal(captures[0].request.headers.authorization,'Bearer private-key');
  assert.equal(JSON.parse(captures[0].request.body).response_format.type,'json_schema');
  assert.equal(result.usage.promptTokens,9);
  assert.equal(result.message.content,'{"action":"finish"}');
});
test('Stage 4B provider fails closed on invalid settings, native history and HTTP errors', async () => {
  assert.throws(()=>new OpenAiCompatibleProvider({baseUrl:'http://u:p@localhost',apiKey:'x',model:'x'}),/without embedded credentials/);
  assert.throws(()=>new OpenAiCompatibleProvider({baseUrl:'http://localhost',apiKey:'',model:'x'}),/token/);
  const p = new OpenAiCompatibleProvider({baseUrl:'http://localhost/v1',apiKey:'x',model:'x',fetchImpl:async()=>response({},401)});
  await assert.rejects(p.chat({messages:[{role:'user',content:'x'}],tools:[{type:'function'}]}),/LLM_MODE=json only/);
  await assert.rejects(p.chat({messages:[{role:'user',content:'x'}]}),/HTTP 401/);
});

test('Stage 4B MCP session initializes, discovers paginated tools and invokes an approved tool', async () => {
  const requests = [];
  const client = new McpHttpClient({url:'http://localhost:9000/mcp',token:'secret',fetchImpl:async (_url,request)=>{
    const payload = JSON.parse(request.body); requests.push({payload,headers:request.headers});
    if(payload.method==='initialize') return response({jsonrpc:'2.0',id:payload.id,result:{protocolVersion:'2025-06-18'}},200,{'mcp-session-id':'my-session'});
    if(payload.method==='notifications/initialized') return response(null,202);
    if(payload.method==='tools/list') return response({jsonrpc:'2.0',id:payload.id,result:payload.params.cursor
      ? {tools:[{name:'lookup',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}
      : {tools:[{name:'other',inputSchema:{type:'object',properties:{},additionalProperties:false}}],nextCursor:'next'}});
    if(payload.method==='tools/call') return response({jsonrpc:'2.0',id:payload.id,result:{content:[{type:'text',text:'ok'}]}});
  }});
  const listed = await client.listTools();
  assert.equal(listed.length,2);
  assert.equal(requests.at(-1).headers['Mcp-Session-Id'],'my-session');
  const result = await client.callTool('lookup',{});
  assert.equal(result.content[0].text,'ok');
  assert.equal(requests.at(-1).headers.Authorization,'Bearer secret');
});

test('Stage 4B MCP response identity, server protocol and transport errors fail closed', async () => {
  const client = new McpHttpClient({url:'http://localhost/mcp',token:'secret',fetchImpl:async()=>response({jsonrpc:'2.0',id:999,result:{protocolVersion:'2025-06-18'}})});
  await assert.rejects(client.listTools(),/mismatch/);
  const server = new McpHttpClient({url:'http://localhost/mcp',token:'secret',fetchImpl:async(_url,opts)=>response({jsonrpc:'2.0',id:JSON.parse(opts.body).id,result:{protocolVersion:'bad'}})});
  await assert.rejects(server.initialize(),/unsupported/);
});

test('Stage 4B catalog registers only allowlisted tools, validates arguments and mediates calls', async () => {
  const registry = new ToolRegistry();
  let called = 0;const events=[];
  const catalog = {listTools:async()=>[{name:'lookup',description:'Only a read tool',inputSchema:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string'}}}},{name:'delete_everything',inputSchema:{type:'object',properties:{}}}],
    callTool:async(name,args)=>{called++;assert.equal(name,'lookup');return{structuredContent:{id:args.id}}}};
  const result = await attachMcpCatalog({registry,client:catalog,allowlist:['lookup'],log:(event,value)=>events.push({event,value})});
  assert.deepEqual(result.enabled,['course_lookup']);
  assert.equal(registry.getSpecs().length,1);
  assert.equal((await registry.invoke({name:'course_lookup',arguments:{id:'p1'}})).data.id,'p1');
  assert.equal((await registry.invoke({name:'course_lookup',arguments:{not_id:'p1'}})).error.code,'invalid_arguments');
  assert.equal((await registry.invoke({name:'course_delete_everything',arguments:{}})).error.code,'unknown_tool');
  assert.equal(called,1);
  assert.equal(events.at(0).event,'course_mcp_catalog');
});
test('Stage 4B catalog rejects mismatches and does not automatically retry ambiguous remote actions', async () => {
  const registry = new ToolRegistry();
  const catalog = {listTools:async()=>[{name:'act',inputSchema:{type:'object',additionalProperties:false,properties:{}}}],callTool:async()=>{throw new Error('network disconnected');}};
  await assert.rejects(attachMcpCatalog({registry:new ToolRegistry(),client:catalog,allowlist:['missing']}),/did not match/);
  await attachMcpCatalog({registry,client:catalog,allowlist:['act']});
  const result = await registry.invoke({name:'course_act',arguments:{}});
  assert.equal(result.ok,false); assert.equal(result.error.code,'outcome_unknown');
  assert.equal(registry.hasUncertainOutcome,true);
});

test('Stage 4B objective channel validates strict NDJSON and rejects malformed input', () => {
  assert.deepEqual(parseObjectiveLine('{"type":"objective","id":"seq1","objective":"Deliver 2 parcels"}'),{id:'seq1',objective:'Deliver 2 parcels'});
  assert.throws(()=>parseObjectiveLine('not json'),/JSON object/);
  assert.throws(()=>parseObjectiveLine('{"objective":23}'),/Invalid objective/);
  assert.throws(()=>parseObjectiveLine('x'.repeat(5000)),/too large/);
});
test('Stage 4B objective replacement is latest wins, serialized, and cancels only at a safe boundary', async () => {
  const events=[];let busy=true;let concurrent=0;let maxConcurrent=0;
  const inbox = new ObjectiveInbox({pollMs:2,isActionBusy:()=>busy,stopCurrent:()=>{},log:(event,details)=>events.push({event,...details}),
    runObjective:async(goal,{signal})=>{
      concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
      if(goal==='first') {await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}
      concurrent--;return {status:goal==='first'?'cancelled':'completed',reason:goal==='first'?'objective_replaced_or_cancelled':'verified'};
    }});
  inbox.submit({id:'first',objective:'first'});
  inbox.submit({id:'obsolete',objective:'obsolete'});
  inbox.submit({id:'second',objective:'second'});
  await wait(15);
  assert.equal(events.some(e=>e.event==='course_objective_replacement_requested'),false);
  busy=false;
  await inbox.drain();
  assert.equal(maxConcurrent,1);
  assert.deepEqual(events.filter(e=>e.event==='course_objective_started').map(e=>e.id),['first','second']);
  assert.equal(events.filter(e=>e.event==='course_objective_replacement_requested').length,1);
});
test('Stage 4B objective inbox quarantines on uncertain outcome; does not run queued replacement', async()=>{
  let ran=0;
  const inbox = new ObjectiveInbox({isActionBusy:()=>false,stopCurrent:()=>{},runObjective:async()=>{ran++;await wait(8);return {status:'blocked',reason:'uncertain_tool_outcome'};}});
  inbox.submit({id:'a',objective:'first'});inbox.submit({id:'b',objective:'second'});
  await assert.rejects(inbox.drain(),/requires reconciliation/);
  assert.equal(ran,1);assert.equal(inbox.quarantined,true);
});
test('Stage 4B objective inbox deduplicates IDs and requires safe message content', async()=>{
  let ran=0;
  const inbox = new ObjectiveInbox({isActionBusy:()=>false,stopCurrent:()=>{},runObjective:async()=>{ran++;return {status:'completed',reason:'verified'};}});
  assert.equal(inbox.submit({id:'a',objective:'Deliver 1 parcel'}),true);
  assert.equal(inbox.submit({id:'a',objective:'Deliver 2 parcels'}),false);
  assert.throws(()=>inbox.submit({id:'b',objective:'  '}),/Objective must/);
  await inbox.drain();assert.equal(ran,1);
});

test('Stage 4A audit distinguishes implementation from absent official integration and sanitizes secrets',()=>{
  const report=auditRequirements({exists:path=>!path.includes('nonexistent')});
  const pddl=report.requirements.find(x=>x.id==='P1-04');
  const catalog=report.requirements.find(x=>x.id==='P2-05');
  assert.equal(pddl.status,'requires_live_check');
  assert.equal(catalog.status,'pending_official');
  assert.match(auditMarkdown(report),/course API endpoint/);
  const check=courseIntegrationChecklist({LLM_PROVIDER:'openai_compatible',LLM_MODE:'json',COURSE_LLM_TOKEN:'VERY_SECRET',COURSE_LLM_BASE_URL:'https://x/v1',COURSE_LLM_MODEL:'model'});
  assert.equal(check.openAiCompatibleConfigured,true);
  assert.equal(JSON.stringify(check).includes('VERY_SECRET'),false);
  assert.equal(check.officialEndpointVerified,false);
});

test('Stage 4B unresolved in-flight action prevents objective replacement and triggers quarantine', async()=>{
  const events=[];let cancelled=false;
  const inbox = new ObjectiveInbox({pollMs:2,maxDeferredMs:5,isActionBusy:()=>true,stopCurrent:()=>{cancelled=true;},log:(event,value)=>events.push({event,...value}),
    runObjective:async(_goal,{signal})=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return{status:'cancelled',reason:'objective_replaced_or_cancelled'};}});
  inbox.submit({id:'a',objective:'Deliver 1 parcel'});inbox.submit({id:'b',objective:'Deliver 2 parcels'});
  await assert.rejects(inbox.drain(),/requires reconciliation/);
  assert.equal(cancelled,true);assert.ok(events.some(e=>e.reason==='unsafe_action_did_not_settle'));
});

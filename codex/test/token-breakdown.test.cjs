'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const metadata=require('../per-chat-metadata.cjs');
const fixtures=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'token-fixtures-'));
function event(input,cached,output,reasoning=0){return JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:reasoning,total_tokens:input+output}}}})+'\n';}
function read(file){assert.equal(typeof metadata.readTokenBreakdown,'function','Token counters must be readable independently');return metadata.readTokenBreakdown(file);}
test('uses the latest cumulative snapshot without adding repeated counters or reasoning twice',()=>{
 const file=path.join(fixtures,'cumulative.jsonl');fs.writeFileSync(file,event(100,60,10,2)+event(200,150,20,4)+event(200,150,20,4));
 const result=read(file);
 assert.equal(result.cachedInput,150);assert.equal(result.uncachedInput,50);assert.equal(result.output,20);assert.equal(result.total,220);assert.equal(result.hitRate,.75);
 assert.equal(result.cachedInput+result.uncachedInput+result.output,result.total);
});
test('refreshes changed files and handles truncation',()=>{
 const file=path.join(fixtures,'changing.jsonl');fs.writeFileSync(file,event(100,60,10));assert.equal(read(file).total,110);
 fs.appendFileSync(file,event(200,150,20));assert.equal(read(file).cachedInput,150);
 fs.writeFileSync(file,event(10,5,1));assert.equal(read(file).total,11);
});
test('finds the counter before a large trailing event',()=>{
 const file=path.join(fixtures,'tail.jsonl');fs.writeFileSync(file,event(200,150,20)+JSON.stringify({type:'test-fixture',value:'x'.repeat(400000)})+'\n');
 assert.equal(read(file).total,220);
});
test('does not turn missing or invalid counters into zero',()=>{
 assert.equal(read(path.join(fixtures,'missing.jsonl')),null);
 const file=path.join(fixtures,'invalid.jsonl');fs.writeFileSync(file,event(100,200,10));assert.equal(read(file),null);
});
test('combines a chat and its descendants once, preserving the token identity',()=>{
 const home=path.join(fixtures,'home');fs.mkdirSync(home);
 const parent='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
 const parentFile=path.join(home,'parent.jsonl'),childFile=path.join(home,'child.jsonl');
 fs.writeFileSync(parentFile,event(200,150,20));fs.writeFileSync(childFile,event(50,30,5));
 const db=new DatabaseSync(path.join(home,'state_1.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,created_at INTEGER,tokens_used INTEGER,rollout_path TEXT);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);');
 const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?)');insert.run(parent,1,220,parentFile);insert.run(child,2,55,childFile);
 db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(parent,child);db.close();
 const row=metadata.readMetadata([parent],home)[0];
 assert.ok(row.breakdown,'A complete chat must expose its combined breakdown');
 assert.equal(row.breakdown.cachedInput,180);assert.equal(row.breakdown.uncachedInput,70);assert.equal(row.breakdown.output,25);
 assert.equal(row.breakdown.total,275);assert.equal(row.tokens+row.descendant_tokens,275);
});
function usage(input,cached,output,lastInput){return JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,total_tokens:input+output},last_token_usage:{input_tokens:lastInput}}}})+'\n';}
function context(model){return JSON.stringify({type:'turn_context',payload:{model}})+'\n';}
test('prices each request at its model and context tier, skipping repeated snapshots',()=>{
 const file=path.join(fixtures,'cost.jsonl');
 // Sol: 1M input (800K cached), 100K output -> 0.8*0.1 + 0.2*2 + 0.1*10 = 1.48
 // Then a long request on Sol: +300K input all cached, +10K output -> (0.3*0.1)*2 + 0.01*10*1.5 = 0.21
 // Then Terra: +1M uncached, +0 output -> 1.0
 fs.writeFileSync(file,context('gpt-6.1-sol')+usage(1e6,8e5,1e5,1e6/4)+usage(1e6,8e5,1e5,1e6/4)+usage(13e5,11e5,11e4,3e5)+context('gpt-6.1-terra')+usage(23e5,11e5,11e4,1e5));
 const cost=metadata.readApiCost(file,'gpt-6.1-sol');
 assert.ok(Math.abs(cost.usd-2.69)<1e-9,String(cost.usd));assert.equal(cost.longRequests,1);
 fs.appendFileSync(file,usage(23e5,11e5,12e4,1e5));
 assert.ok(Math.abs(metadata.readApiCost(file,'gpt-6.1-sol').usd-2.74)<1e-9,'Appended requests are added incrementally');
});
function count(total,lastInput){return JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:total,last_token_usage:{input_tokens:lastInput??total.input_tokens}}}})+'\n';}
function priced(model,body){const file=path.join(fixtures,`tier-${model}-${Math.random().toString(16).slice(2)}.jsonl`);fs.writeFileSync(file,context(model)+body);return metadata.readApiCost(file,model);}
test('combined cache writes use the 30-minute rate, and a split bills 12-hour writes at 2.5x',()=>{
 // 1K combined write on Sol, short context: 1.25 * $2.
 const combined=priced('gpt-6.1-sol',count({input_tokens:1000,cached_input_tokens:0,cache_write_input_tokens:1000,output_tokens:0,total_tokens:1000}));
 assert.ok(Math.abs(combined.usd-0.0025)<1e-9,String(combined.usd));
 // The same 1K split into 12-hour writes: 2.5 * $2. The combined counter must not be added again.
 const twelve=priced('gpt-6.1-sol',count({input_tokens:1000,cached_input_tokens:0,cache_write_input_tokens:1000,output_tokens:0,total_tokens:1000,cache_write_tokens_details:{ttl_30m_tokens:0,ttl_12h_tokens:1000}}));
 assert.ok(Math.abs(twelve.usd-0.005)<1e-9,String(twelve.usd));
 // 400 at 30 minutes and 600 at 12 hours.
 const mixed=priced('gpt-6-astra',count({input_tokens:1000,cached_input_tokens:0,output_tokens:0,total_tokens:1000,input_tokens_details:{cache_write_tokens_details:{ttl_30m_tokens:400,ttl_12h_tokens:600}}}));
 assert.ok(Math.abs(mixed.usd-(400*10*1.25+600*10*2.5)/1e6)<1e-9,String(mixed.usd));
 // Long context still doubles the write. 300K of 12-hour writes on Astra is the published $50 rate.
 const longWrite=priced('gpt-6-astra',count({input_tokens:300000,cached_input_tokens:0,output_tokens:0,total_tokens:300000,cache_write_tokens_details:{ttl_30m_tokens:0,ttl_12h_tokens:300000}},300000));
 assert.ok(Math.abs(longWrite.usd-15)<1e-9,String(longWrite.usd));assert.equal(longWrite.longRequests,1);
 // Undifferentiated long write on Sol stays at 1.25x, then the 2x long-context multiplier.
 const legacy=priced('gpt-6.1-sol',count({input_tokens:300000,cached_input_tokens:100000,cache_write_input_tokens:50000,output_tokens:1000,total_tokens:301000},300000));
 assert.ok(Math.abs(legacy.usd-0.885)<1e-9,String(legacy.usd));
});
test('newer and earlier OpenAI text models use the published short-context rates',()=>{
 const rows=[
  ['gpt-6-sol',2,0.2,10],['gpt-5.6-sol',4,0.4,20],['gpt-5.6-terra',2,0.2,12],['gpt-5.6-luna',0.2,0.02,1.2],
  ['gpt-5.5',5,0.5,30],['gpt-5.4',2.5,0.25,15],['gpt-5.4-mini',0.75,0.075,4.5],['gpt-5.4-nano',0.2,0.02,1.25],
  ['gpt-5.3-codex',1.75,0.175,14],['gpt-5.2',1.75,0.175,14],['gpt-5.1',1.25,0.125,10],['gpt-5',1.25,0.125,10],
  ['gpt-5-mini',0.25,0.025,2],['gpt-5-nano',0.05,0.005,0.4],['gpt-4.1',2,0.5,8],['gpt-4.1-mini',0.4,0.1,1.6],
  ['gpt-4o',2.5,1.25,10],['gpt-4o-mini',0.15,0.075,0.6],['o3',2,0.5,8]
 ];
 for(const [model,input,cached,output] of rows){
  const cost=priced(model,count({input_tokens:2000,cached_input_tokens:1000,output_tokens:1000,total_tokens:3000}));
  const expected=(input+cached+output)*1000/1e6;
  assert.ok(cost&&Math.abs(cost.usd-expected)<1e-9,`${model} ${cost&&cost.usd} != ${expected}`);
  assert.equal(cost.longRequests,0);
 }
 // gpt-6-sol's cache hit is $0.20, not gpt-6.1-sol's $0.10. A cache write has no extra fee before GPT-5.6.
 const sol=priced('gpt-6-sol',count({input_tokens:1000,cached_input_tokens:1000,output_tokens:0,total_tokens:1000}));
 assert.ok(Math.abs(sol.usd-0.0002)<1e-9,String(sol.usd));
 const codexWrite=priced('gpt-5.3-codex',count({input_tokens:1000,cached_input_tokens:0,cache_write_input_tokens:1000,output_tokens:0,total_tokens:1000}));
 assert.ok(Math.abs(codexWrite.usd-0.00175)<1e-9,String(codexWrite.usd));
 // Models without a long-context tier stay on the short rate above 272K.
 const mini=priced('gpt-5.4-mini',count({input_tokens:300000,cached_input_tokens:0,output_tokens:0,total_tokens:300000},300000));
 assert.ok(Math.abs(mini.usd-300000*0.75/1e6)<1e-9,String(mini.usd));assert.equal(mini.longRequests,0);
 // GPT-5.5 does have the tier: input doubles and output is 1.5x.
 const long=priced('gpt-5.5',count({input_tokens:300000,cached_input_tokens:0,output_tokens:1000,total_tokens:301000},300000));
 assert.ok(Math.abs(long.usd-(300000*10+1000*45)/1e6)<1e-9,String(long.usd));assert.equal(long.longRequests,1);
 // Pro rows have no cache price. A cache hit, or a 12-hour write on a model that has no 12-hour fee, leaves the cost unknown.
 const pro=priced('gpt-5.5-pro',count({input_tokens:1000,cached_input_tokens:0,output_tokens:1000,total_tokens:2000}));
 assert.ok(Math.abs(pro.usd-(30+180)*1000/1e6)<1e-9,String(pro.usd));
 assert.equal(priced('gpt-5.5-pro',count({input_tokens:1000,cached_input_tokens:1000,output_tokens:0,total_tokens:1000})),null);
 assert.equal(priced('o3-pro',count({input_tokens:1000,cached_input_tokens:0,output_tokens:0,total_tokens:1000,cache_write_tokens_details:{ttl_30m_tokens:0,ttl_12h_tokens:1000}})),null);
});
test('an unknown model leaves the API cost unknown instead of zero',()=>{
 const file=path.join(fixtures,'unknown.jsonl');fs.writeFileSync(file,context('mystery-model')+usage(100,0,10,100));
 assert.equal(metadata.readApiCost(file,null),null);
});
test('settings fall back to defaults and ignore invalid values',()=>{
 const dir=fs.mkdtempSync(path.join(fixtures,'config-'));
 assert.deepEqual(metadata.readConfig(dir),metadata.DEFAULT_CONFIG);
 fs.writeFileSync(path.join(dir,'per-chat-usage.config.json'),JSON.stringify({monthlyPrice:20,currency:'USD',weeksPerMonth:-1,usdToCny:'x'}));
 assert.deepEqual(metadata.readConfig(dir),{...metadata.DEFAULT_CONFIG,monthlyPrice:20,currency:'USD'});
});

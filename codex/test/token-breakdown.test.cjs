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
test('invalid settings JSON keeps defaults and reports the file',()=>{
 const dir=fs.mkdtempSync(path.join(fixtures,'config-bad-'));
 fs.writeFileSync(path.join(dir,'per-chat-usage.config.json'),'{');
 const errors=[];
 const write=console.error;
 console.error=(...args)=>errors.push(args.join(' '));
 try {
  assert.deepEqual(metadata.readConfig(dir),metadata.DEFAULT_CONFIG);
  assert.match(errors.join('\n'),/invalid JSON/);
 } finally { console.error=write; }
});

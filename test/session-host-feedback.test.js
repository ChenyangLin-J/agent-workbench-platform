import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHostController } from '../src/session-host.js';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
for (const project of [null, 'project-a']) test(`submission feedback is immediate, separate from execution and reconciles native IDs (${project || 'project-free'})`, async () => {
  const reply=deferred(); let listener; let messages=[]; let keys=[];
  const host=createSessionHostController({ initialSessionId:'session-a', submissionFeedback:true, adapter:{
    listSessions:async()=>[], readSession:async()=>({sessionId:'session-a', projectId:project, status:'idle', messages}),
    subscribeSession:(_,options)=>{listener=options.onEvent; return()=>{};},
    submissionMessage:(_,payload)=>({role:'user',content:payload.prompt}),
    isSubmissionEcho:(snapshot,submission)=>snapshot.messages.some(item=>!submission.baseline.includes(item.id)&&item.content===submission.message.content),
    applyEvent:(_,event)=>event.payload,
    execute:async(_,__,___,options)=>{keys.push(options.idempotencyKey); return reply.promise;},
  }});
  await host.start(); const first=host.execute('send',{prompt:'hello'}); const repeat=host.execute('send',{prompt:'hello'});
  assert.equal(host.getSnapshot().session.status,'idle');
  assert.equal(host.getSnapshot().session.messages.length,1);
  assert.equal(host.getSnapshot().session.messages[0].deliveryState,'sending');
  messages=[{id:'native-item',role:'user',content:'hello'}];
  listener({sessionId:'session-a',payload:{sessionId:'session-a',status:'running',messages}});
  assert.deepEqual(host.getSnapshot().session.messages.map(item=>item.id),['native-item']);
  reply.resolve({accepted:true}); await Promise.all([first,repeat]); assert.equal(keys.length,1);
  host.dispose();
});
test('unknown results have a bounded send state and retry preserves identity; known failure removes feedback',async()=>{
 let calls=0; const keys=[]; const host=createSessionHostController({initialSessionId:'a',submissionFeedback:true,operationTimeoutMs:10,adapter:{
  listSessions:async()=>[],readSession:async()=>({sessionId:'a',messages:[]}),
  submissionMessage:(_,p)=>({role:'user',content:p.prompt}),
  execute:async(_,__,___,o)=>{keys.push(o.idempotencyKey);calls++;if(calls===1)return new Promise(()=>{});throw Object.assign(new Error('rejected'),{knownResult:true});}
 }});await host.start();await assert.rejects(host.execute('send',{prompt:'retry'}),/暂未确认/);
 assert.equal(host.getSnapshot().session.messages[0].deliveryState,'unknown');
 await assert.rejects(host.execute('send',{prompt:'retry'}),/rejected/);
 assert.equal(keys[0],keys[1]);assert.deepEqual(host.getSnapshot().session.messages,[]);host.dispose();
});
test('selected transport binding can change while logical selection and draft remain, and late old events are ignored',async()=>{
 let binding='old';let callbacks;const clean=[];
 const host=createSessionHostController({initialSessionId:'logical',adapter:{
 listSessions:async()=>[],readSession:async()=>({sessionId:'logical',webSessionId:binding,threadId:'native',messages:[{id:binding}],draft:'keep me'}),
 subscribeSession:(_,options)=>{const current=binding;callbacks=options;return()=>clean.push(current);},
 reconcileSelection:snapshot=>({bindingChanged:snapshot.webSessionId!==binding}),applyEvent:(_,e)=>e.payload,
 }});await host.start();const old=callbacks;binding='new';host.updateSessions([]);await host.reconcileSelectedSession();
 assert.equal(host.getSnapshot().selectedId,'logical');assert.equal(host.getSnapshot().session.draft,'keep me');assert.equal(host.getSnapshot().session.webSessionId,'new');assert.deepEqual(clean,['old']);
 old.onEvent({sessionId:'logical',payload:{sessionId:'logical',webSessionId:'old',messages:[]}});
 assert.equal(host.getSnapshot().session.webSessionId,'new');host.dispose();
});

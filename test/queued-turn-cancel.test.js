import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSessionKernel } from '../src/runtime/core/index.js';
import { FakeRuntimeProvider,InMemoryBindingStore } from './core-testkit.js';
for(const context of [null,{projectId:'injected-project'}])test(`cancel one queued input without starting it (${context?'scoped':'project-free'})`,async()=>{
 const provider=new FakeRuntimeProvider();const kernel=new AgentSessionKernel({provider,bindingStore:new InMemoryBindingStore(),validateRequest:()=>{}});
 await kernel.attach('session',{cwd:'/tmp',context});await kernel.submit('session',{text:'active'});
 const cancelled=kernel.submit('session',{text:'remove'},{mode:'queue',clientUserMessageId:'queue-a'});
 const rejected=assert.rejects(cancelled,{code:'QUEUED_TURN_CANCELLED'});await new Promise(resolve=>setImmediate(resolve));
 kernel.cancelQueuedTurn('session','queue-a');await rejected;provider.createdSessions[0].complete();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(provider.createdSessions[0].startedTurns.length,1);assert.throws(()=>kernel.cancelQueuedTurn('session','queue-a'),{code:'QUEUED_TURN_NOT_FOUND'});await kernel.close();
});

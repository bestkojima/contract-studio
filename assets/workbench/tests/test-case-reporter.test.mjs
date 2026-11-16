import test from 'node:test';
import assert from 'node:assert/strict';
import reporter from '../scripts/test-case-reporter.mjs';

test('用例 reporter 只记录真实完成事件，区分 skip/todo 并保留错误消息',async()=>{
  const events=[
    {type:'test:start',data:{name:'not completed'}},
    {type:'test:pass',data:{name:'suite',details:{type:'suite'}}},
    {type:'test:pass',data:{name:'[TEST_PASS] pass',file:'/repo/a.test.mjs',line:3,details:{type:'test',duration_ms:1.5}}},
    {type:'test:pass',data:{name:'skip',skip:true,details:{type:'test'}}},
    {type:'test:fail',data:{name:'todo',todo:'pending',details:{type:'test',error:new Error('todo failure')}}},
    {type:'test:fail',data:{name:'fail',details:{type:'test',error:new Error('wrapper',{cause:new Error('assertion failed')})}}},
  ];
  const actual=[];
  for await (const line of reporter(events)) actual.push(JSON.parse(line));
  assert.deepEqual(actual.map(item=>item.state),['passed','skipped','skipped','failed']);
  assert.deepEqual(actual[0],{id:'TEST_PASS',name:'[TEST_PASS] pass',file:'/repo/a.test.mjs',line:3,state:'passed',durationMs:1.5});
  assert.equal(actual[1].id,null,'a label without a stable ID does not create a traceability identity');
  assert.equal(actual[2].message,'pending');
  assert.equal(actual[3].message,'assertion failed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedTestCases, testIdFromName } from '../server/indexed-tests.mjs';

test('native test meaning comes from Needs; source ownership comes from unique CodeLinks paths',()=>{
  const needs={
    REQ_ONE:{id:'REQ_ONE',type:'req',parts:{AC_ONE:{id:'AC_ONE'},PART_412E31:{id:'PART_412E31'}}},
    TEST_NEW:{id:'TEST_NEW',type:'test',title:'A newly authored test',verifies:['REQ_ONE.AC_ONE','REQ_ONE.PART_412E31','REQ_ONE.MISSING','REQ_ONE']},
  };
  const entity={path:'tests/new.test.mjs',needIds:['TEST_NEW'],markerLines:[2],indexState:'current'};
  const [result]=indexedTestCases(needs,[entity,{...entity,markerLines:[8]}]);
  assert.equal(result.id,'TEST_NEW');assert.equal(result.name,'A newly authored test');
  assert.equal(result.file,'tests/new.test.mjs');assert.equal(result.sourceState,'resolved');
  assert.deepEqual(result.verifies.map(link=>link.state),['linked','linked','missing-acceptance','linked']);
  assert.deepEqual(result.verifies.map(link=>link.acceptanceId),['AC_ONE','A.1','MISSING',null]);
  const [ambiguous]=indexedTestCases(needs,[entity,{...entity,path:'tests/duplicate.test.mjs'}]);
  assert.equal(ambiguous.sourceState,'ambiguous');assert.equal(ambiguous.file,null);
  const [missing]=indexedTestCases(needs,[]);
  assert.equal(missing.sourceState,'missing');assert.equal(missing.file,null);
  assert.equal(indexedTestCases(needs,[{...entity,indexState:'stale'}])[0].indexState,'stale');
  const declaration={...entity,declarations:[{needId:'TEST_NEW',line:2,endLine:5,kind:'test'}]};
  const [native]=indexedTestCases(needs,[declaration,{...entity,path:'server/consumer.mjs'}]);
  assert.equal(native.file,'tests/new.test.mjs','references to a native test do not become its definition');
  const [duplicate]=indexedTestCases(needs,[declaration,{...declaration,path:'tests/duplicate.test.mjs'}]);
  assert.equal(duplicate.sourceState,'ambiguous','two native definitions still cannot be guessed');
});

test('runtime identity uses the leading stable ID, independent of the human-readable test name',()=>{
  assert.equal(testIdFromName('[TEST_ONE] changed title'),'TEST_ONE');
  assert.equal(testIdFromName('[CASE_001]'),'CASE_001');
  assert.equal(testIdFromName('title with [TEST_ONE] later'),null);
  assert.equal(testIdFromName('ordinary test'),null);
});

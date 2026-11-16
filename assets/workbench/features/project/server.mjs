// Reviewed executable declarations belong here; graph data only describes behavior.
const feature={
  id:'project',alias:'project',title:'项目功能图',rootNodeId:'root',defaultSelected:'root',
  defaultUi:true,defaultTrace:true,
  graphFile:'contracts/project.json',requirementFile:'contracts/requirements.json',rstFile:'traceability/project.rst',
  frontend:{entry:'project',feature:'project',component:'ProjectPanel',path:'features/project/client.tsx',mode:'project'},
  draftKeys:{graph:'contract-studio-project-graph-v1',base:'contract-studio-project-graph-base-v1',pending:'contract-studio-project-graph-pending-v1',requirements:'contract-studio-project-requirement-drafts-v1'}
};
export default {id:'project',features:[feature],capabilities:[],routes:[],trials:[]};

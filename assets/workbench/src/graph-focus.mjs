// A read-only projection: layout coordinates never enter the contract graph.
export function graphFocus(graph,nodeId) {
  const selected=graph.nodes.find(node=>node.id===nodeId);
  if(!selected)return {ids:new Set(),positions:new Map(),ancestors:[]};
  const incoming=[...new Set(graph.edges.filter(edge=>edge.target===nodeId).map(edge=>edge.source))];
  const outgoing=[...new Set(graph.edges.filter(edge=>edge.source===nodeId).map(edge=>edge.target))];
  const children=graph.nodes.filter(node=>node.parentId===nodeId).map(node=>node.id);
  const ids=new Set([nodeId,...incoming,...outgoing,...children]);
  const positions=new Map([[nodeId,{x:300,y:40}]]);
  const place=(list,x,y)=>{let index=0;for(const id of list)if(id!==nodeId&&!positions.has(id))positions.set(id,{x,y:y+index++*170});};
  place(incoming,20,40);place(outgoing,580,40);
  // Child contracts use the available width; a long single column shrinks labels.
  const remaining=children.filter(id=>!positions.has(id));
  const startY=Math.max(...[...positions.values()].map(position=>position.y))+200;
  const columns=Math.min(3,remaining.length);
  for(let index=0;index<remaining.length;index++){
    const row=Math.floor(index/3),inRow=Math.min(3,remaining.length-row*3);
    positions.set(remaining[index],{x:300-(inRow-1)*140+(index%columns)*280,y:startY+row*180});
  }
  const ancestors=[];let parent=selected.parentId;const seen=new Set([nodeId]);
  while(parent&&!seen.has(parent)){
    seen.add(parent);const node=graph.nodes.find(node=>node.id===parent);if(!node)break;
    ancestors.unshift({id:node.id,title:node.title});parent=node.parentId;
  }
  return {ids,positions,ancestors};
}

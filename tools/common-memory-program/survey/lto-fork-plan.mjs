export function ltoForkPlan(manifest) {
 const keys=['none','full','thin'].flatMap(mode=>['raw','preopt'].map(preparation=>`${mode}-${preparation}`));
 if(manifest.failures.length||keys.length!==Object.keys(manifest.variants).length||keys.some(key=>!manifest.variants[key]))
  throw Error('complete successful LTO fixture builds required; keep failures visible');
 return keys.flatMap(mode=>[
  {mode,addressing:'native',shared:false,expectedExit:0},
  {mode,addressing:'vm',shared:false,expectedExit:0},
  {mode,addressing:'vm',shared:true,expectedExit:0},
  {mode,addressing:'native',shared:true,expectedExit:26},
 ].map(row=>({...row,id:`${mode}-${row.addressing}-${row.shared?'shared':'private'}`})));
}

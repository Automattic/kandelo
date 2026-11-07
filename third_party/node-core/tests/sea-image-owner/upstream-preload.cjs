'use strict';
if(process.env.SEA_SUBJECT==='candidate'){
 const Module=require('node:module'),path=require('node:path');
 const {api}=require('./platform.cjs')(path.resolve(__dirname,'../../../..'),process.env.SEA_IMAGE_COMPONENT);
 const original=Module._load;Module._load=function(request,parent,isMain){if(request==='node:sea')return api;return Reflect.apply(original,this,[request,parent,isMain]);};
}

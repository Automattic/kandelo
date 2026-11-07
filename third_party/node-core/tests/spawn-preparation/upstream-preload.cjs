'use strict';
// Only public spawn/returned ChildProcess are candidate source; other builtin
// functionality remains explicitly native dependency, not guest support.
const Module=require('node:module'),native=require('node:child_process');
const candidate=require('./platform.cjs').create();
const subject={...native,spawn:candidate.spawn,ChildProcess:candidate.ChildProcess};
const load=Module._load;
Module._load=function(name,...args){return name==='child_process'||name==='node:child_process'?subject:Reflect.apply(load,this,[name,...args])};

use fork_instrument::streaming::*;
use wasm_encoder::{
    ExportKind, Function, ValType,
    reencode::{Error, Reencode},
};

struct Transform {
    runtime: NativeRuntime,
    codecs: FrozenFrameCodecs,
    declarations: FrozenDeclarations,
    module: FrozenModuleDeclarations,
}
impl Reencode for Transform {
    type Error = ImportIndexError;
    fn function_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.function_index(i)
    }
    fn table_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.table_index(i)
    }
    fn memory_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.memory_index(i)
    }
    fn global_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.global_index(i)
    }
    fn tag_index(&mut self, i: u32) -> Result<u32, Error<Self::Error>> {
        self.runtime.tag_index(i)
    }
}
impl FunctionTransform for Transform {
    fn imports(&self) -> Option<&FrozenImports> {
        Some(self.runtime.imports_plan())
    }
    fn declarations(&self) -> Option<&FrozenDeclarations> {
        Some(&self.declarations)
    }
    fn module_declarations(&self) -> Option<&FrozenModuleDeclarations> {
        Some(&self.module)
    }
    fn emit_helper(&mut self, helper: u32, limit: usize) -> anyhow::Result<Function> {
        if helper < 7 {
            self.runtime.emit_control(helper, limit)
        } else {
            self.codecs.emit_helper(helper - 7, limit)
        }
    }
}

fn artifact(wide: bool, selector: bool, commits: bool) -> Vec<u8> {
    let input = wat::parse_str(if wide {
        r#"(module (memory (export "memory") i64 1))"#
    } else {
        r#"(module (memory (export "memory") 1))"#
    })
    .unwrap();
    let scan = scan(&input).unwrap();
    let runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    let mut map = wasm_encoder::reencode::RoundtripReencoder;
    let environment = FrameEnvironment::discover(&scan, &mut map, 1 << 20).unwrap();
    let mut catalog = FrameCodecCatalog::new(
        environment,
        runtime.indices(),
        scan.types.as_ref().core_type_count_in_module()
            + runtime.function_declarations().type_count(),
        runtime.imports_plan().helper_function_base() + 7,
        1 << 20,
    )
    .unwrap();
    let shape = FrameCodecShape {
        scalars: vec![ValType::I64, ValType::I32, ValType::F32, ValType::F64],
        catch_selector: selector,
        commits,
        restored_scalars: usize::from(!selector),
    };
    let pair = catalog.request(&shape).unwrap();
    let mut different = shape.clone();
    different.commits = !commits;
    let other = catalog.request(&different).unwrap();
    assert_eq!(
        pair.restore, other.restore,
        "restore ignores save-commit policy"
    );
    assert_ne!(pair.save, other.save);
    let codecs = catalog.freeze().unwrap();
    assert_eq!(codecs.lookup(&shape).unwrap(), pair);
    let mut unknown = shape.clone();
    unknown.scalars = vec![ValType::I32];
    assert!(codecs.lookup(&unknown).is_err());
    let mut invalid = shape.clone();
    invalid.restored_scalars = 99;
    assert!(codecs.lookup(&invalid).is_err());
    assert!(codecs.emit_helper(999, 1 << 20).is_err());
    assert!(codecs.emit_helper(0, 1).is_err());
    let declarations = FrozenDeclarations::concatenate(
        &[runtime.function_declarations(), codecs.declarations()],
        1 << 20,
    )
    .unwrap();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(runtime.imports_plan()),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    module.export("save", ExportKind::Func, pair.save).unwrap();
    module
        .export("restore", ExportKind::Func, pair.restore)
        .unwrap();
    module
        .export(
            "call_index",
            ExportKind::Global,
            runtime.indices().call_index_global,
        )
        .unwrap();
    module
        .export("frame", ExportKind::Global, runtime.indices().frame_global)
        .unwrap();
    let mut output = Vec::new();
    emit_remapped(
        &scan,
        &mut Transform {
            runtime,
            codecs,
            declarations,
            module: module.freeze(),
        },
        &mut output,
        Default::default(),
    )
    .unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn shared_scalar_save_restore_preserve_headers_commit_order_and_single_result_on_node() {
    for wide in [false, true] {
        for selector in [false, true] {
            for commits in [false, true] {
                let bytes = artifact(wide, selector, commits);
                assert_eq!(bytes, artifact(wide, selector, commits));
                let file = tempfile::NamedTempFile::new().unwrap();
                std::fs::write(file.path(), bytes).unwrap();
                let result=std::process::Command::new("node").arg("-e").arg(r#"
          const fs=require('fs'),assert=require('node:assert/strict'),wide=process.argv[2]==='1',selector=process.argv[3]==='1',commits=process.argv[4]==='1';
          const m=new WebAssembly.Module(fs.readFileSync(process.argv[1])),imports={},events=[];
          let instance;const ptr=n=>wide?BigInt(n):n;
          for(const x of WebAssembly.Module.imports(m)){
            const s=imports[x.module]??={};
            s[x.name]=x.kind==='function'?()=>0:x.kind==='table'?new WebAssembly.Table({element:'anyfunc',initial:1}):x.kind==='tag'?new WebAssembly.Tag({parameters:[]}):null;
            if(x.name==='__wpk_fork_frame_next')s[x.name]=size=>{assert.equal(size,ptr(40));events.push('next');return ptr(8192);};
            if(x.name==='__wpk_fork_frame_commit')s[x.name]=p=>{assert.equal(p,ptr(8192));const d=new DataView(instance.exports.memory.buffer);assert.equal(d.getFloat64(8192+32,true),7.125);events.push('commit');};
          }
          instance=new WebAssembly.Instance(m,imports);const e=instance.exports,d=new DataView(e.memory.buffer);
          e.wpk_fork_unwind_begin(ptr(512));if(wide)d.setBigUint64(512,8192n,true);else d.setUint32(512,8192,true);
          d.setUint32(8192+4,777,true);const args=[55];if(selector)args.push(3);args.push(42n,17,-1.25,7.125);e.save(...args);
          assert.deepEqual(events,commits?['commit']:[]);assert.equal(d.getUint32(8192,true),55);assert.equal(d.getUint32(8192+4,true),777);assert.equal(d.getUint32(8192+8,true),selector?3:0);assert.equal(d.getUint32(8192+12,true),0);
          assert.equal(e.restore(ptr(40)),selector?3:42n);assert.equal(e.call_index.value,777);assert.equal(e.frame.value,ptr(8192));
          assert.equal(d.getInt32(8192+24,true),17);assert.equal(d.getFloat32(8192+28,true),-1.25);assert.equal(events.at(-1),'next');
        "#).arg(file.path()).arg(if wide{"1"}else{"0"}).arg(if selector{"1"}else{"0"}).arg(if commits{"1"}else{"0"}).output().unwrap();
                assert!(
                    result.status.success(),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
            }
        }
    }
}

#[test]
fn codec_catalog_rejects_metadata_and_result_policy_errors_before_freezing() {
    let input = wat::parse_str("(module (memory 1))").unwrap();
    let scan = scan(&input).unwrap();
    let runtime = NativeRuntime::plan(&scan, Default::default(), 8192).unwrap();
    let mut map = wasm_encoder::reencode::RoundtripReencoder;
    let environment = FrameEnvironment::discover(&scan, &mut map, 8192).unwrap();
    let mut catalog = FrameCodecCatalog::new(environment, runtime.indices(), 100, 100, 1).unwrap();
    let mut shape = FrameCodecShape {
        scalars: vec![ValType::I32],
        catch_selector: false,
        commits: true,
        restored_scalars: 2,
    };
    assert!(catalog.request(&shape).is_err());
    shape.restored_scalars = 1;
    assert!(catalog.request(&shape).is_err());
    assert_eq!(catalog.freeze().unwrap().declarations().function_count(), 0);
}

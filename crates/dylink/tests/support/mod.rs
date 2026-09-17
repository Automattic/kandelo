//! A minimal wasm-binary builder for the linker's tests.
//!
//! The planner is a pure function of module BYTES, so its fixtures are bytes.
//! Building them here rather than compiling C keeps every test in this crate
//! runnable with plain `cargo test` and no toolchain, and — more importantly —
//! lets a test construct shapes a real compiler will not emit on demand: two
//! import entries with the same `(module, name)`, a weak `GOT.mem` next to a
//! strong one, an export that merely re-exports an import.
//!
//! Fixture breadth is K5's gate, not polish, so this builder is deliberately
//! general rather than shaped around any one library.

#![allow(dead_code)]

pub fn leb_u32(mut value: u32, out: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

pub fn leb_i32(value: i32, out: &mut Vec<u8>) {
    let mut value = value;
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        let sign_bit = byte & 0x40 != 0;
        if (value == 0 && !sign_bit) || (value == -1 && sign_bit) {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

pub fn name(text: &str, out: &mut Vec<u8>) {
    leb_u32(text.len() as u32, out);
    out.extend_from_slice(text.as_bytes());
}

pub fn section(id: u8, body: Vec<u8>, out: &mut Vec<u8>) {
    out.push(id);
    leb_u32(body.len() as u32, out);
    out.extend_from_slice(&body);
}

/// `dylink.0` sub-section ids.
pub const MEM_INFO: u32 = 1;
pub const NEEDED: u32 = 2;
pub const EXPORT_INFO: u32 = 3;
pub const IMPORT_INFO: u32 = 4;

pub const FLAG_TLS: u32 = 0x01;
pub const FLAG_WEAK: u32 = 0x02;

#[derive(Default)]
pub struct DylinkSection {
    pub memory_size: u32,
    pub memory_align: u32,
    pub table_size: u32,
    pub table_align: u32,
    pub needed: Vec<String>,
    /// `(export name, flags)`
    pub export_info: Vec<(String, u32)>,
    /// `(import module, field, flags)`
    pub import_info: Vec<(String, String, u32)>,
    /// Emit an unknown sub-section id, to prove forward compatibility.
    pub unknown_subsection: Option<(u32, Vec<u8>)>,
}

impl DylinkSection {
    pub fn encode(&self) -> Vec<u8> {
        let mut payload = Vec::new();
        name("dylink.0", &mut payload);

        let mut mem = Vec::new();
        leb_u32(self.memory_size, &mut mem);
        leb_u32(self.memory_align, &mut mem);
        leb_u32(self.table_size, &mut mem);
        leb_u32(self.table_align, &mut mem);
        subsection(MEM_INFO, mem, &mut payload);

        if !self.needed.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.needed.len() as u32, &mut body);
            for entry in &self.needed {
                name(entry, &mut body);
            }
            subsection(NEEDED, body, &mut payload);
        }
        if !self.export_info.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.export_info.len() as u32, &mut body);
            for (export, flags) in &self.export_info {
                name(export, &mut body);
                leb_u32(*flags, &mut body);
            }
            subsection(EXPORT_INFO, body, &mut payload);
        }
        if !self.import_info.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.import_info.len() as u32, &mut body);
            for (module, field, flags) in &self.import_info {
                name(module, &mut body);
                name(field, &mut body);
                leb_u32(*flags, &mut body);
            }
            subsection(IMPORT_INFO, body, &mut payload);
        }
        if let Some((id, body)) = &self.unknown_subsection {
            subsection(*id, body.clone(), &mut payload);
        }
        payload
    }
}

fn subsection(id: u32, body: Vec<u8>, out: &mut Vec<u8>) {
    leb_u32(id, out);
    leb_u32(body.len() as u32, out);
    out.extend_from_slice(&body);
}

/// One import declaration to encode.
#[derive(Clone)]
pub enum Import {
    Func { module: String, field: String, type_index: u32 },
    Global { module: String, field: String, val_type: u8, mutable: bool },
    Memory { module: String, field: String },
    Table { module: String, field: String },
    Tag { module: String, field: String, type_index: u32 },
}

impl Import {
    pub fn func(module: &str, field: &str) -> Self {
        Import::Func {
            module: module.into(),
            field: field.into(),
            type_index: 0,
        }
    }

    /// A mutable i32 global, which is what every GOT cell is on wasm32.
    pub fn got(module: &str, field: &str) -> Self {
        Import::Global {
            module: module.into(),
            field: field.into(),
            val_type: 0x7f,
            mutable: true,
        }
    }

    pub fn immutable_global(module: &str, field: &str) -> Self {
        Import::Global {
            module: module.into(),
            field: field.into(),
            val_type: 0x7f,
            mutable: false,
        }
    }

    pub fn tag(module: &str, field: &str) -> Self {
        Import::Tag {
            module: module.into(),
            field: field.into(),
            type_index: 0,
        }
    }

    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Import::Func { module, field, type_index } => {
                name(module, out);
                name(field, out);
                out.push(0x00);
                leb_u32(*type_index, out);
            }
            Import::Global { module, field, val_type, mutable } => {
                name(module, out);
                name(field, out);
                out.push(0x03);
                out.push(*val_type);
                out.push(u8::from(*mutable));
            }
            Import::Memory { module, field } => {
                name(module, out);
                name(field, out);
                out.push(0x02);
                out.push(0x03); // has max + shared
                leb_u32(1, out);
                leb_u32(16, out);
            }
            Import::Table { module, field } => {
                name(module, out);
                name(field, out);
                out.push(0x01);
                out.push(0x70); // funcref
                out.push(0x00);
                leb_u32(0, out);
            }
            Import::Tag { module, field, type_index } => {
                name(module, out);
                name(field, out);
                out.push(0x04);
                out.push(0x00);
                leb_u32(*type_index, out);
            }
        }
    }
}

/// One export declaration to encode.
#[derive(Clone)]
pub struct Export {
    pub name: String,
    /// 0 = func, 1 = table, 2 = memory, 3 = global.
    pub kind: u8,
    pub index: u32,
}

impl Export {
    pub fn func(name: &str, index: u32) -> Self {
        Export { name: name.into(), kind: 0, index }
    }

    pub fn global(name: &str, index: u32) -> Self {
        Export { name: name.into(), kind: 3, index }
    }
}

/// A side-module fixture.
#[derive(Default)]
pub struct SideModule {
    pub dylink: DylinkSection,
    pub imports: Vec<Import>,
    pub exports: Vec<Export>,
    /// Active element segment on table 0: `(offset, function indices)`.
    pub elements: Vec<(i32, Vec<u32>)>,
    /// `true` = passive, `false` = active. Contents are irrelevant.
    pub data_segments: Vec<bool>,
    pub start_function: Option<u32>,
    /// Omit the `dylink.0` section entirely, making this a main module.
    pub omit_dylink: bool,
}

impl SideModule {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        if !self.omit_dylink {
            // The ABI requires dylink.0 to be the module's FIRST section.
            section(0, self.dylink.encode(), &mut out);
        }
        if !self.imports.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.imports.len() as u32, &mut body);
            for import in &self.imports {
                import.encode(&mut body);
            }
            section(2, body, &mut out);
        }
        if !self.exports.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.exports.len() as u32, &mut body);
            for export in &self.exports {
                name(&export.name, &mut body);
                body.push(export.kind);
                leb_u32(export.index, &mut body);
            }
            section(7, body, &mut out);
        }
        if let Some(start) = self.start_function {
            let mut body = Vec::new();
            leb_u32(start, &mut body);
            section(8, body, &mut out);
        }
        if !self.elements.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.elements.len() as u32, &mut body);
            for (offset, functions) in &self.elements {
                // flags = 0: active, table 0, i32 offset expr, vec of indices,
                // and NO element-kind byte.
                leb_u32(0, &mut body);
                body.push(0x41);
                leb_i32(*offset, &mut body);
                body.push(0x0b);
                leb_u32(functions.len() as u32, &mut body);
                for function in functions {
                    leb_u32(*function, &mut body);
                }
            }
            section(9, body, &mut out);
        }
        if !self.data_segments.is_empty() {
            let mut body = Vec::new();
            leb_u32(self.data_segments.len() as u32, &mut body);
            for passive in &self.data_segments {
                if *passive {
                    leb_u32(1, &mut body);
                    leb_u32(2, &mut body);
                    body.extend_from_slice(&[0xaa, 0xbb]);
                } else {
                    leb_u32(0, &mut body);
                    body.push(0x41);
                    leb_i32(0, &mut body);
                    body.push(0x0b);
                    leb_u32(2, &mut body);
                    body.extend_from_slice(&[0xaa, 0xbb]);
                }
            }
            section(11, body, &mut out);
        }
        out
    }
}

/// The smallest well-formed side module: 64 bytes of data, no imports.
pub fn trivial_side_module() -> Vec<u8> {
    SideModule {
        dylink: DylinkSection {
            memory_size: 64,
            memory_align: 4,
            table_size: 0,
            table_align: 0,
            ..Default::default()
        },
        ..Default::default()
    }
    .encode()
}

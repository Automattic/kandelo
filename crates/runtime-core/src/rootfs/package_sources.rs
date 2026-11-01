use super::*;
use crate::package_inventory::{self, Content, File, Inventory, PackageSpec};

const MAX_URI_BYTES: usize = 4096;

fn decoded_component(component: &[u8]) -> Result<(), Errno> {
    if component.is_empty() { return Err(Errno::EINVAL); }
    let mut position = 0;
    let mut dots = 0;
    let mut length = 0;
    let mut previous = [0u8; 2];
    while position < component.len() {
        let byte = if component[position] == b'%' {
            let digits = component.get(position + 1..position + 3).ok_or(Errno::EINVAL)?;
            let digit = |byte: u8| match byte {
                b'0'..=b'9' => Ok(byte - b'0'),
                b'a'..=b'f' => Ok(byte - b'a' + 10),
                b'A'..=b'F' => Ok(byte - b'A' + 10),
                _ => Err(Errno::EINVAL),
            };
            position += 3;
            digit(digits[0])? * 16 + digit(digits[1])?
        } else {
            let byte = component[position];
            position += 1;
            if !byte.is_ascii_alphanumeric() && !b"-._~!$&'()+,;=@".contains(&byte) {
                return Err(Errno::EINVAL);
            }
            byte
        };
        if byte < b' ' || byte == 127 || b"/\\".contains(&byte)
            || (previous[0] == b'%' && previous[1].is_ascii_hexdigit() && byte.is_ascii_hexdigit())
        { return Err(Errno::EINVAL); }
        previous = [previous[1], byte];
        length += 1;
        dots += usize::from(byte == b'.');
    }
    if length == dots && length <= 2 { return Err(Errno::EINVAL); }
    Ok(())
}

fn validate_directory(directory: &[u8]) -> Result<(), Errno> {
    if directory.len() > MAX_URI_BYTES { return Err(Errno::E2BIG); }
    let rest = directory.strip_prefix(b"https://").or_else(|| directory.strip_prefix(b"http://")).ok_or(Errno::EINVAL)?;
    let slash = rest.iter().position(|byte| *byte == b'/').ok_or(Errno::EINVAL)?;
    let authority = &rest[..slash];
    if authority.is_empty() || !authority.iter().all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(byte)) {
        return Err(Errno::EINVAL);
    }
    let port = if authority[0] == b'[' {
        let close = authority.iter().position(|byte| *byte == b']').ok_or(Errno::EINVAL)?;
        if close <= 1 || !authority[1..close].iter().all(|byte| byte.is_ascii_hexdigit() || b":.".contains(byte)) {
            return Err(Errno::EINVAL);
        }
        let suffix = &authority[close + 1..];
        if suffix.is_empty() { None } else { Some(suffix.strip_prefix(b":").ok_or(Errno::EINVAL)?) }
    } else {
        if authority.contains(&b'[') || authority.contains(&b']') { return Err(Errno::EINVAL); }
        match authority.iter().position(|byte| *byte == b':') {
            Some(position) if position != 0 => Some(&authority[position + 1..]),
            Some(_) => return Err(Errno::EINVAL),
            None => None,
        }
    };
    if let Some(port) = port {
        if port.is_empty() || !port.iter().all(u8::is_ascii_digit) { return Err(Errno::EINVAL); }
        port.iter().try_fold(0u16, |value, byte| value.checked_mul(10)
            .and_then(|value| value.checked_add(u16::from(*byte - b'0'))).ok_or(Errno::EINVAL))?;
    }
    let path = &rest[slash + 1..];
    if directory.last() != Some(&b'/') { return Err(Errno::EINVAL); }
    if !path.is_empty() {
        for component in path[..path.len() - 1].split(|byte| *byte == b'/') { decoded_component(component)?; }
    }
    let identity = path.strip_suffix(b"/").and_then(|path| path.rsplit(|byte| *byte == b'/').next()).ok_or(Errno::EINVAL)?;
    if identity.len() != 64 || !identity.iter().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)) {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

fn pin_uri(uri: &[u8], directory: &[u8], digest: [u8; 32]) -> Result<Option<Vec<u8>>, Errno> {
    let member = uri.strip_prefix(b"kandelo-lazy:programs/")
        .or_else(|| uri.strip_prefix(b"binaries/programs/"));
    let Some(member) = member else {
        if uri.starts_with(b"kandelo-lazy:") { return Err(Errno::EINVAL); }
        let colon = uri.iter().position(|byte| *byte == b':').ok_or(Errno::EOPNOTSUPP)?;
        let scheme = &uri[..colon];
        if !scheme.eq_ignore_ascii_case(b"http") && !scheme.eq_ignore_ascii_case(b"https") { return Err(Errno::EOPNOTSUPP); }
        let address = uri[colon..].strip_prefix(b"://").ok_or(Errno::EINVAL)?;
        let authority = address.split(|byte| b"/?#".contains(byte)).next().ok_or(Errno::EINVAL)?;
        if authority.is_empty() || uri.iter().any(|byte| *byte <= b' ' || *byte == 127 || *byte == b'\\') {
            return Err(Errno::EINVAL);
        }
        return Ok(None);
    };
    if digest == crate::sdef::DIGEST_NONE { return Err(Errno::EIO); }
    if member.len() > MAX_URI_BYTES { return Err(Errno::E2BIG); }
    if member == b"wasm32" || member == b"wasm64" { return Err(Errno::EINVAL); }
    for component in member.split(|byte| *byte == b'/') { decoded_component(component)?; }
    let architecture = if member.starts_with(b"wasm32/") || member.starts_with(b"wasm64/") { &b""[..] } else { &b"wasm32/"[..] };
    let count = directory.len().checked_add(b"assets/programs/".len())
        .and_then(|count| count.checked_add(architecture.len()))
        .and_then(|count| count.checked_add(member.len())).ok_or(Errno::E2BIG)?;
    if count > MAX_URI_BYTES { return Err(Errno::E2BIG); }
    let mut pinned = Vec::new();
    pinned.try_reserve_exact(count).map_err(|_| Errno::ENOMEM)?;
    for part in [directory, b"assets/programs/", architecture, member] {
        pinned.extend_from_slice(part);
    }
    Ok(Some(pinned))
}

pub fn pin_inventory(bytes: &[u8], directory: &[u8]) -> Result<crate::IoBuffer<u8>, Errno> {
    validate_directory(directory)?;
    let inventory = Inventory::decode(bytes)?;
    let mut providers = package_inventory::metadata_with_capacity(inventory.files().len())?;
    for file in inventory.files() {
        providers.push(match file.content {
            Content::Deferred { provider, .. } => Some(provider_record::pin_sources(provider, directory)?),
            _ => None,
        });
    }
    let mut files = package_inventory::metadata_with_capacity(inventory.files().len())?;
    for (file, provider) in inventory.files().iter().zip(providers.iter()) {
        files.push(File { content: match file.content {
            Content::Deferred { size, digest, .. } => Content::Deferred {
                size, digest, provider: provider.as_ref().ok_or(Errno::EIO)?,
            },
            content => content,
        }, ..*file });
    }
    let mut dependencies = package_inventory::metadata_with_capacity(inventory.packages().len())?;
    for package in inventory.packages() {
        let mut pins = package_inventory::metadata_with_capacity(package.dependencies().len())?;
        for dependency in package.dependencies() { pins.push(dependency); }
        dependencies.push(pins);
    }
    let mut packages = package_inventory::metadata_with_capacity(inventory.packages().len())?;
    for (package, dependencies) in inventory.packages().iter().zip(dependencies.iter()) {
        packages.push(PackageSpec { name: package.name, version: package.version,
            content_digest: Some(package.content_digest), dependencies });
    }
    package_inventory::encode(inventory.program_abi(), inventory.program_digest(), &packages, &files)
}

pub(super) fn pin_provider_uri(uri: &[u8], directory: &[u8], digest: [u8; 32]) -> Result<Option<Vec<u8>>, Errno> {
    pin_uri(uri, directory, digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_owned_source_pins_are_absolute_content_specific_and_architecture_preserving() {
        let directory = alloc::format!("https://example.test/{}/", "a".repeat(64));
        let next = alloc::format!("https://example.test/{}/", "b".repeat(64));
        for (reference, member) in [(b"kandelo-lazy:programs/tool.wasm".as_slice(), "wasm32/tool.wasm"),
            (b"binaries/programs/wasm64/tool.wasm", "wasm64/tool.wasm")] {
            let value = pin_uri(reference, directory.as_bytes(), [7; 32]).unwrap().unwrap();
            assert_eq!(value, alloc::format!("{directory}assets/programs/{member}").as_bytes());
            assert_ne!(Some(value.clone()), pin_uri(reference, next.as_bytes(), [8; 32]).unwrap());
            assert_eq!(pin_uri(&value, next.as_bytes(), [7; 32]).unwrap(), None);
        }
    }

    #[test]
    fn pinning_rejects_ambiguous_directories_and_member_escapes() {
        for base in ["https://example.test/", "http://127.0.0.1:57455/", "http://[::1]:1234/"] {
            validate_directory(alloc::format!("{base}{}/", "a".repeat(64)).as_bytes()).unwrap();
        }
        for directory in [b"https://example.test/a".as_slice(), b"https://user@example.test/", b"https://example.test/a/?x/",
            b"https://example.test/%2e%2e/", b"https://example.test/%252e/", b"https://example.test:65536/", b"file:///tmp/"] {
            assert_eq!(validate_directory(directory), Err(Errno::EINVAL));
        }
        for member in [b"../tool".as_slice(), b"%2e%2e/tool", b"%252e%252e/tool", b"%2ftool", b"wasm32//tool", b"tool?next=bad", b"tool\\bad"] {
            let reference = [b"kandelo-lazy:programs/".as_slice(), member].concat();
            assert_eq!(pin_uri(&reference, b"https://example.test/", [7; 32]), Err(Errno::EINVAL));
        }
        for reference in [b"assets/data.zip".as_slice(), b"/data.zip", b"//other.test/data.zip", b"blob:dead", b"file:relative", b"data:text/plain,bytes"] {
            assert_eq!(pin_uri(reference, b"https://example.test/", [7; 32]), Err(Errno::EOPNOTSUPP));
        }
        for reference in [b"http:relative".as_slice(), b"https:///missing-host", b"https://example.test\\other/"] {
            assert_eq!(pin_uri(reference, b"https://example.test/", [7; 32]), Err(Errno::EINVAL));
        }
        assert_eq!(pin_uri(b"HTTPS://example.test/resource", b"https://example.test/", [7; 32]), Ok(None));
    }
}

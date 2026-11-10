fn main() {
    cc::Build::new().file("native.c").compile("from_c");
    cc::Build::new().cpp(true).flag("-fwasm-exceptions").file("native.cpp").compile("from_cpp");
    println!("cargo:rustc-link-lib=c++abi");
    println!("cargo:rerun-if-changed=native.c");
    println!("cargo:rerun-if-changed=native.cpp");
}

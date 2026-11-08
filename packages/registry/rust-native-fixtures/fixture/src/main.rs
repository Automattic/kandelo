unsafe extern "C" { fn from_c()->i32; fn from_cpp()->i32; }
fn main() {
    let values=unsafe { (from_c(),from_cpp()) };
    assert_eq!(values,(42,7));
    println!("cc-rs native execution={}/{}",values.0,values.1);
}

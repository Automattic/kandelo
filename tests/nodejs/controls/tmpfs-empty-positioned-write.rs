use std::{env,fs::{self,OpenOptions},os::unix::{fs::{FileExt,MetadataExt,PermissionsExt},io::AsRawFd}};
use runtime_core::tmpfs;
#[repr(C)] struct Timespec { sec:i64,nsec:i64 }
unsafe extern "C" {fn futimens(fd:i32,times:*const Timespec)->i32;}
fn native_empty(index:usize,offset:u64,seed:bool)->bool {
 let path=env::temp_dir().join(format!("kandelo-empty-write-{}-{index}",std::process::id()));
 let file=OpenOptions::new().read(true).write(true).create_new(true).open(&path).unwrap();
 if seed{assert_eq!(file.write_at(b"seed",0).unwrap(),4);}
 let times=[Timespec{sec:1000,nsec:5},Timespec{sec:2000,nsec:7}];assert_eq!(unsafe{futimens(file.as_raw_fd(),times.as_ptr())},0);
 fs::set_permissions(&path,fs::Permissions::from_mode(0o6755)).unwrap();
 let before=file.metadata().unwrap();let n=file.write_at(&[],offset).unwrap();let after=file.metadata().unwrap();
 let pass=n==0&&before.size()==after.size()&&before.mode()==after.mode()&&(before.mtime(),before.mtime_nsec())==(after.mtime(),after.mtime_nsec())&&(before.ctime(),before.ctime_nsec())==(after.ctime(),after.ctime_nsec());
 println!("{{\"case\":{index},\"count\":{n},\"sizeBefore\":{},\"sizeAfter\":{},\"metadataUnchanged\":{pass}}}",before.size(),after.size());fs::remove_file(path).unwrap();pass
}
fn candidate_empty(index:usize,offset:i64,seed:bool)->bool {
 let path=format!("/tmp/empty-write-{index}");let h=tmpfs::open(path.as_bytes(),0o102,0o6755,0,0).unwrap();
 if seed{assert_eq!(tmpfs::write(h,0,b"seed").unwrap(),4);}
 tmpfs::chmod(path.as_bytes(),0o6755).unwrap();tmpfs::utimensat(path.as_bytes(),1000,5,2000,7,2500,9).unwrap();tmpfs::set_now(3000,11);
 let before=tmpfs::fstat(h).unwrap();let n=tmpfs::write(h,offset,&[]).unwrap();let after=tmpfs::fstat(h).unwrap();
 let pass=n==0&&before.st_size==after.st_size&&before.st_mode==after.st_mode&&(before.st_mtime_sec,before.st_mtime_nsec)==(after.st_mtime_sec,after.st_mtime_nsec)&&(before.st_ctime_sec,before.st_ctime_nsec)==(after.st_ctime_sec,after.st_ctime_nsec);
 println!("{{\"case\":{index},\"count\":{n},\"sizeBefore\":{},\"sizeAfter\":{},\"metadataUnchanged\":{pass}}}",before.st_size,after.st_size);tmpfs::release_handle(h);pass
}
fn main(){
 let native=env::args().nth(1).as_deref()==Some("native");let mut failures=0;
 for(index,(offset,seed))in[(0,true),(4,true),(4096,true),(4096,false)].into_iter().enumerate(){let pass=if native{native_empty(index,offset as u64,seed)}else{candidate_empty(index,offset,seed)};if!pass{failures+=1;}}
 println!("{{\"cases\":4,\"failures\":{failures},\"guestExecuted\":false}}");if failures!=0{std::process::exit(1);}
}

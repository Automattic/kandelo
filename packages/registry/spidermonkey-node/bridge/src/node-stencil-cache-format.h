#ifndef KANDELO_NODE_STENCIL_CACHE_FORMAT_H
#define KANDELO_NODE_STENCIL_CACHE_FORMAT_H

#include <cstddef>
#include <cstdint>
#include <cstring>

// Native transport for SpiderMonkey XDR data. This does not encode JS pointers
// or Node policy. All fields are little endian and accessed without alignment
// assumptions. The XDR payload starts at its required four-byte alignment.
namespace kandelo::node::cache {
inline constexpr size_t kHeaderSize=128;
inline constexpr uint32_t kSchema=1;
inline constexpr uint8_t kMagic[8]={'K','N','D','L','S','T','N','1'};
enum class Kind:uint32_t {Script,Module,Function};
enum class Check {Success,Magic,Version,Flags,Checksum,Header,Length};

// FNV-1a fingerprints detect mismatched sources/parameters and accidental cache
// damage. They are not an authentication mechanism. XDR is compiled-data input
// and retains the engine's existing trust contract.
struct Fingerprint {
  uint64_t value=14695981039346656037ULL;
  void Byte(uint8_t byte){value=(value^byte)*1099511628211ULL;}
  void Bytes(const uint8_t* bytes,size_t count){for(size_t i=0;i<count;++i)Byte(bytes[i]);}
  void Word(uint64_t word){for(unsigned i=0;i<8;++i){Byte(uint8_t(word));word>>=8;}}
  void Text(const char16_t* text,size_t length){
    Word(length);
    for(size_t i=0;i<length;++i){Byte(uint8_t(text[i]));Byte(uint8_t(text[i]>>8));}
  }
};
inline uint32_t Read32(const uint8_t* bytes){
  uint32_t value=0;for(unsigned i=0;i<4;++i)value|=uint32_t(bytes[i])<<(8*i);return value;
}
inline uint64_t Read64(const uint8_t* bytes){
  uint64_t value=0;for(unsigned i=0;i<8;++i)value|=uint64_t(bytes[i])<<(8*i);return value;
}
inline void Write32(uint8_t* bytes,uint32_t value){
  for(unsigned i=0;i<4;++i){bytes[i]=uint8_t(value);value>>=8;}
}
inline void Write64(uint8_t* bytes,uint64_t value){
  for(unsigned i=0;i<8;++i){bytes[i]=uint8_t(value);value>>=8;}
}
struct Description {
  Kind kind=Kind::Script;
  uint32_t flags=0;
  uint64_t source=0,parameters=0;
  uint32_t originFlags=0;
  bool nonSyntactic=false;
};
inline uint64_t Checksum(const uint8_t* bytes,size_t length){
  Fingerprint hash;hash.Bytes(bytes,120);
  hash.Bytes(bytes+kHeaderSize,length-kHeaderSize);return hash.value;
}
inline void Write(uint8_t* bytes,size_t length,const Description& description,
    const char* identity,uint32_t version){
  std::memset(bytes,0,kHeaderSize);std::memcpy(bytes,kMagic,sizeof(kMagic));
  Write32(bytes+8,kSchema);Write32(bytes+12,version);std::memcpy(bytes+16,identity,64);
  Write32(bytes+80,uint32_t(description.kind));Write32(bytes+84,description.flags);
  Write64(bytes+88,description.source);Write64(bytes+96,description.parameters);
  Write32(bytes+104,description.originFlags);Write32(bytes+108,description.nonSyntactic);
  Write64(bytes+112,length-kHeaderSize);Write64(bytes+120,Checksum(bytes,length));
}
inline Check Validate(const uint8_t* bytes,size_t length,const char* identity,uint32_t version){
  if(length<kHeaderSize||!bytes)return Check::Header;
  if(std::memcmp(bytes,kMagic,sizeof(kMagic)))return Check::Magic;
  if(Read32(bytes+8)!=kSchema||Read32(bytes+12)!=version||std::memcmp(bytes+16,identity,64))return Check::Version;
  if(Read32(bytes+80)>uint32_t(Kind::Function)||(Read32(bytes+84)&~uint32_t(2))||
      (Read32(bytes+104)&~uint32_t(15))||Read32(bytes+108)>1||
      (Read32(bytes+80)!=uint32_t(Kind::Function)&&Read32(bytes+108)))return Check::Flags;
  if(Read64(bytes+112)!=uint64_t(length-kHeaderSize))return Check::Length;
  if(Read64(bytes+120)!=Checksum(bytes,length))return Check::Checksum;
  return Check::Success;
}
}
#endif

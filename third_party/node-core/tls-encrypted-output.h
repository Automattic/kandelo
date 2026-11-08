// Original encrypted BIO storage is retained until real TCP acknowledgment.
#ifndef KANDELO_NODE_TLS_ENCRYPTED_OUTPUT_H_
#define KANDELO_NODE_TLS_ENCRYPTED_OUTPUT_H_
#include "socket-owner.h"
#include <openssl/bio.h>
#include <openssl/ssl.h>
#include <memory>
namespace kandelo::tls {
class EncryptedOutput {
  struct BioFree { void operator()(BIO* bio) const noexcept { BIO_free(bio); } };
  using Bio = std::unique_ptr<BIO, BioFree>;
  socket::Owner& parent_;
  socket::TransportAttachment& authority_;
  const uint64_t parentGeneration_;
  // Keep BOTH BIO objects: nread0 borrows the peer writer's ring allocation.
  // Retaining only the reader would not keep that allocation alive.
  Bio writer_, reader_;
  socket::TransportWrite write_;
  uint64_t sequence_ = 0;
  char* captured_ = nullptr;
  int error_ = 0;
 public:
  memory::Allocation allocation{sizeof(EncryptedOutput)};
  EncryptedOutput(socket::Owner& parent, socket::TransportAttachment& authority)
      : parent_(parent), authority_(authority), parentGeneration_(parent.Generation()) {}
  ~EncryptedOutput() { Cancel(); }
  bool Initialize(SSL* ssl) noexcept {
    if (!ssl || writer_ || reader_) return false;
    BIO *writer = nullptr, *reader = nullptr;
    if (BIO_new_bio_pair(&writer, 0, &reader, 0) != 1) {
      BIO_free(writer); BIO_free(reader); return false;
    }
    writer_.reset(writer); reader_.reset(reader);
    Bio input(BIO_new_socket(parent_.Fd(), BIO_NOCLOSE));
    if (!input || BIO_up_ref(writer_.get()) != 1) return false;
    // SSL owns input and one writer reference; this owner retains both pair
    // sides through transport completion/cancellation and then acknowledgment.
    SSL_set_bio(ssl, input.release(), writer_.get()); return true;
  }
  short RegisteredEvents() const noexcept {
    if (parent_.Generation() != parentGeneration_) return 0;
    return parent_.TransportWriteRegisteredEvents(authority_, write_);
  }
  bool CanWrite() const noexcept {
    // Exact paired BIO ring space, not socket writability. OpenSSL returns
    // WANT_WRITE when this memory BIO is full even if no socket write waits.
    return writer_ && BIO_ctrl_get_write_guarantee(writer_.get()) != 0;
  }
  bool Pending() const noexcept { return write_.Pending() || (reader_ && BIO_ctrl_pending(reader_.get()) != 0); }
  bool NeedsAcknowledgment() const noexcept { return write_.Ready(); }
  int Error() const noexcept { return error_; }
  size_t PendingBytes() const noexcept { return reader_ ? BIO_ctrl_pending(reader_.get()) : 0; }
  // True only when all produced bytes have been physically written AND their
  // real parent receipt acknowledged. Completion alone does not move BIO head.
  bool Progress(bool acknowledge) noexcept {
    if (error_) return false;
    if (write_.Ready()) {
      if (!acknowledge) return false;
      const int error = write_.Error(); const size_t length = write_.Length();
      if (!parent_.AcknowledgeTransportWrite(authority_, write_, sequence_)) { error_ = EIO; return false; }
      if (error) { error_ = error; return false; }
      char* data = nullptr;
      const int count = BIO_nread(reader_.get(), &data, int(length));
      if (count < 0 || size_t(count) != length || data != captured_) { error_ = EIO; return false; }
      captured_ = nullptr;
    }
    if (!reader_ || !BIO_ctrl_pending(reader_.get())) return true;
    if (parent_.Generation() != parentGeneration_) { error_ = ECANCELED; return false; }
    if (!write_.Pending()) {
      char* data = nullptr; const int count = BIO_nread0(reader_.get(), &data);
      if (count <= 0 || !data) { error_ = EIO; return false; }
      const int error = parent_.QueueTransportWrite(authority_, write_, data, size_t(count));
      if (error) { error_ = error; return false; }
      captured_ = data; sequence_ = write_.Sequence();
    }
    (void)parent_.ProgressTransportWrite(authority_, write_);
    return false;
  }
  void Cancel() noexcept {
    if (!write_.Pending()) return;
    parent_.CancelTransportWrite(authority_, write_);
    // This is the actual captured parent's cancellation acknowledgment, not
    // a fabricated successful flush or an application write callback.
    const bool retired = parent_.AcknowledgeTransportWrite(authority_, write_, sequence_);
    assert(retired); captured_ = nullptr;
  }
};
}  // namespace kandelo::tls
#endif

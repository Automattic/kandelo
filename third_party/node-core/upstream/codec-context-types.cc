constexpr uint8_t GZIP_HEADER_ID1 = 0x1f;
constexpr uint8_t GZIP_HEADER_ID2 = 0x8b;

struct CompressionError {
  CompressionError(const char* message, const char* code, int err)
      : message(message),
        code(code),
        err(err) {
    CHECK_NOT_NULL(message);
  }

  CompressionError() = default;

  const char* message = nullptr;
  const char* code = nullptr;
  int err = 0;

  inline bool IsError() const { return code != nullptr; }
};

void RecordBrotliParam(std::vector<std::pair<int, uint32_t>>* params,
                       int key,
                       uint32_t value) {
  for (auto& entry : *params) {
    if (entry.first == key) {
      entry.second = value;
      return;
    }
  }
  params->emplace_back(key, value);
}

class ZlibContext final : public MemoryRetainer {
 public:
  ZlibContext() = default;

  // Streaming-related, should be available for all compression libraries:
  void Close();
  void DoThreadPoolWork();
  void SetBuffers(const char* in, uint32_t in_len, char* out, uint32_t out_len);
  void SetFlush(int flush);
  void GetAfterWriteOffsets(uint32_t* avail_in, uint32_t* avail_out) const;
  CompressionError GetErrorInfo() const;
  inline void SetMode(node_zlib_mode mode) { mode_ = mode; }
  CompressionError ResetStream();

  // Zlib-specific:
  void Init(int level,
            int window_bits,
            int mem_level,
            int strategy,
            bool reject_garbage_after_end,
            std::vector<unsigned char>&& dictionary);
  CompressionError SetParams(int level, int strategy);

  SET_MEMORY_INFO_NAME(ZlibContext)
  SET_SELF_SIZE(ZlibContext)

  void MemoryInfo(MemoryTracker* tracker) const override {
    tracker->TrackField("dictionary", dictionary_);
  }

  ZlibContext(const ZlibContext&) = delete;
  ZlibContext& operator=(const ZlibContext&) = delete;

 private:
  CompressionError ErrorForMessage(const char* message) const;
  CompressionError SetDictionary();
  bool InitZlib();

  Mutex mutex_;  // Protects zlib_init_done_.
  bool zlib_init_done_ = false;
  int err_ = 0;
  int flush_ = 0;
  int level_ = 0;
  int mem_level_ = 0;
  node_zlib_mode mode_ = NONE;
  int strategy_ = 0;
  int window_bits_ = 0;
  bool reject_garbage_after_end_ = false;
  unsigned int gzip_id_bytes_read_ = 0;
  std::vector<unsigned char> dictionary_;

  // gzip and zlib-wrapped deflate emit a header on the first deflate() call.
  // Resetting after those bytes have left the compressor starts a new member
  // while the fragment remains, so gunzip/inflate fail with Z_DATA_ERROR.
  // Raw deflate has no header; Z_FULL_FLUSH + reset still concatenates.
  // A member is complete once deflate() has been called with Z_FINISH and
  // returned Z_STREAM_END.
  bool stream_complete_ = true;
  bool output_emitted_ = false;

  z_stream strm_;
};

// Brotli has different data types for compression and decompression streams,
// so some of the specifics are implemented in more specific subclasses
class BrotliContext : public MemoryRetainer {
 public:
  BrotliContext() = default;

  void SetBuffers(const char* in, uint32_t in_len, char* out, uint32_t out_len);
  void SetFlush(int flush);
  void GetAfterWriteOffsets(uint32_t* avail_in, uint32_t* avail_out) const;
  inline void SetMode(node_zlib_mode mode) { mode_ = mode; }

  BrotliContext(const BrotliContext&) = delete;
  BrotliContext& operator=(const BrotliContext&) = delete;

 protected:
  node_zlib_mode mode_ = NONE;
  const uint8_t* next_in_ = nullptr;
  uint8_t* next_out_ = nullptr;
  size_t avail_in_ = 0;
  size_t avail_out_ = 0;
  BrotliEncoderOperation flush_ = BROTLI_OPERATION_PROCESS;
  void* alloc_opaque_ = nullptr;
};

class BrotliEncoderContext final : public BrotliContext {
 public:
  void Close();
  void DoThreadPoolWork();
  CompressionError Init(std::vector<uint8_t>&& dictionary = {});
  CompressionError ResetStream();
  CompressionError SetParams(int key, uint32_t value);
  CompressionError GetErrorInfo() const;

  SET_MEMORY_INFO_NAME(BrotliEncoderContext)
  SET_SELF_SIZE(BrotliEncoderContext)
  SET_NO_MEMORY_INFO()  // state_ is covered through allocation tracking.

 private:
  bool last_result_ = false;
  DeleteFnPtr<BrotliEncoderState, BrotliEncoderDestroyInstance> state_;
  DeleteFnPtr<BrotliEncoderPreparedDictionary,
              BrotliEncoderDestroyPreparedDictionary>
      prepared_dictionary_;
  // Dictionary data must remain valid while the prepared dictionary is alive.
  std::vector<uint8_t> dictionary_;
  // Last successful parameters, replayed by ResetStream.
  std::vector<std::pair<int, uint32_t>> params_;
};

class BrotliDecoderContext final : public BrotliContext {
 public:
  void Close();
  void DoThreadPoolWork();
  CompressionError Init(std::vector<uint8_t>&& dictionary = {});
  CompressionError ResetStream();
  CompressionError SetParams(int key, uint32_t value);
  CompressionError GetErrorInfo() const;

  SET_MEMORY_INFO_NAME(BrotliDecoderContext)
  SET_SELF_SIZE(BrotliDecoderContext)
  SET_NO_MEMORY_INFO()  // state_ is covered through allocation tracking.

 private:
  BrotliDecoderResult last_result_ = BROTLI_DECODER_RESULT_SUCCESS;
  BrotliDecoderErrorCode error_ = BROTLI_DECODER_NO_ERROR;
  std::string error_string_;
  DeleteFnPtr<BrotliDecoderState, BrotliDecoderDestroyInstance> state_;
  // Dictionary data must remain valid for the lifetime of the decoder.
  std::vector<uint8_t> dictionary_;
  // Last successful parameters, replayed by ResetStream.
  std::vector<std::pair<int, uint32_t>> params_;
};

class ZstdContext : public MemoryRetainer {
 public:
  ZstdContext() = default;

  // Streaming-related, should be available for all compression libraries:
  void SetBuffers(const char* in, uint32_t in_len, char* out, uint32_t out_len);
  void SetFlush(int flush);
  void GetAfterWriteOffsets(uint32_t* avail_in, uint32_t* avail_out) const;
  CompressionError GetErrorInfo() const;

  ZstdContext(const ZstdContext&) = delete;
  ZstdContext& operator=(const ZstdContext&) = delete;

 protected:
  ZSTD_EndDirective flush_ = ZSTD_e_continue;

  ZSTD_inBuffer input_ = {nullptr, 0, 0};
  ZSTD_outBuffer output_ = {nullptr, 0, 0};

  ZSTD_ErrorCode error_ = ZSTD_error_no_error;
  std::string error_string_;
  std::string error_code_string_;
};

class ZstdCompressContext final : public ZstdContext {
 public:
  ZstdCompressContext() = default;

  // Streaming-related, should be available for all compression libraries:
  void Close();
  void DoThreadPoolWork();
  CompressionError ResetStream();

  // Zstd specific:
  CompressionError Init(uint64_t pledged_src_size,
                        std::string_view dictionary = {},
                        bool reject_garbage_after_end = false);
  CompressionError SetParameter(int key, int value);

  // Wrap ZSTD_freeCCtx to remove the return type.
  static void FreeZstd(ZSTD_CCtx* cctx) { ZSTD_freeCCtx(cctx); }

  SET_MEMORY_INFO_NAME(ZstdCompressContext)
  SET_SELF_SIZE(ZstdCompressContext)
  SET_NO_MEMORY_INFO()

 private:
  DeleteFnPtr<ZSTD_CCtx, ZstdCompressContext::FreeZstd> cctx_;

  uint64_t pledged_src_size_ = ZSTD_CONTENTSIZE_UNKNOWN;
  std::optional<uint64_t> consumed_src_size_;

  // A frame is complete once ZSTD_compressStream2() has been called with
  // ZSTD_e_end and has returned 0. Resetting an incomplete frame is only unsafe
  // once some of that frame has already been written out: those bytes cannot be
  // discarded, and the next frame would be appended to the fragment. Unflushed
  // internal state alone is cancelled by ZSTD_reset_session_only.
  bool frame_complete_ = true;
  bool frame_output_emitted_ = false;
};

class ZstdDecompressContext final : public ZstdContext {
 public:
  ZstdDecompressContext() = default;

  // Streaming-related, should be available for all compression libraries:
  void Close();
  void DoThreadPoolWork();
  CompressionError GetErrorInfo() const;
  CompressionError ResetStream();

  // Zstd specific:
  CompressionError Init(uint64_t pledged_src_size,
                        std::string_view dictionary = {},
                        bool reject_garbage_after_end = false);

  CompressionError SetParameter(int key, int value);

  // Wrap ZSTD_freeDCtx to remove the return type.
  static void FreeZstd(ZSTD_DCtx* dctx) { ZSTD_freeDCtx(dctx); }

  SET_MEMORY_INFO_NAME(ZstdDecompressContext)
  SET_SELF_SIZE(ZstdDecompressContext)
  SET_NO_MEMORY_INFO()

 private:
  DeleteFnPtr<ZSTD_DCtx, ZstdDecompressContext::FreeZstd> dctx_;
  bool frame_complete_ = false;
  bool decoding_frame_after_complete_ = false;
  bool reject_garbage_after_end_ = false;
  bool ignoring_trailing_input_ = false;
  size_t frame_prefix_size_ = 0;
  uint8_t possible_frame_types_ = 0;
};


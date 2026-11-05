void ZlibContext::Close() {
  {
    Mutex::ScopedLock lock(mutex_);
    if (!zlib_init_done_) {
      dictionary_.clear();
      mode_ = NONE;
      return;
    }
  }

  CHECK_LE(mode_, UNZIP);

  int status = Z_OK;
  if (mode_ == DEFLATE || mode_ == GZIP || mode_ == DEFLATERAW) {
    status = deflateEnd(&strm_);
  } else if (mode_ == INFLATE || mode_ == GUNZIP || mode_ == INFLATERAW ||
             mode_ == UNZIP) {
    status = inflateEnd(&strm_);
  }

  CHECK(status == Z_OK || status == Z_DATA_ERROR);
  mode_ = NONE;

  dictionary_.clear();
}


void ZlibContext::DoThreadPoolWork() {
  bool first_init_call = InitZlib();
  if (first_init_call && err_ != Z_OK) {
    return;
  }

  const Bytef* next_expected_header_byte = nullptr;

  // If the avail_out is left at 0, then it means that it ran out
  // of room.  If there was avail_out left over, then it means
  // that all of the input was consumed.
  switch (mode_) {
    case DEFLATE:
    case GZIP:
    case DEFLATERAW: {
      const unsigned out_before = strm_.avail_out;
      err_ = deflate(&strm_, flush_);
      if (out_before > strm_.avail_out) {
        output_emitted_ = true;
      }
      if (err_ == Z_STREAM_END) {
        stream_complete_ = true;
        output_emitted_ = false;
      } else if (err_ == Z_OK || err_ == Z_BUF_ERROR) {
        stream_complete_ = false;
      }
      break;
    }
    case UNZIP:
      if (strm_.avail_in > 0) {
        next_expected_header_byte = strm_.next_in;
      }

      switch (gzip_id_bytes_read_) {
        case 0:
          if (next_expected_header_byte == nullptr) {
            break;
          }

          if (*next_expected_header_byte == GZIP_HEADER_ID1) {
            gzip_id_bytes_read_ = 1;
            next_expected_header_byte++;

            if (strm_.avail_in == 1) {
              // The only available byte was already read.
              break;
            }
          } else {
            mode_ = INFLATE;
            break;
          }

          [[fallthrough]];
        case 1:
          if (next_expected_header_byte == nullptr) {
            break;
          }

          if (*next_expected_header_byte == GZIP_HEADER_ID2) {
            gzip_id_bytes_read_ = 2;
            mode_ = GUNZIP;
          } else {
            // There is no actual difference between INFLATE and INFLATERAW
            // (after initialization).
            mode_ = INFLATE;
          }

          break;
        default:
          UNREACHABLE("invalid number of gzip magic number bytes read");
      }

      [[fallthrough]];
    case INFLATE:
    case GUNZIP:
    case INFLATERAW:
      err_ = inflate(&strm_, flush_);

      // If data was encoded with dictionary (INFLATERAW will have it set in
      // SetDictionary, don't repeat that here)
      if (mode_ != INFLATERAW &&
          err_ == Z_NEED_DICT &&
          !dictionary_.empty()) {
        // Load it
        err_ = inflateSetDictionary(&strm_,
                                    dictionary_.data(),
                                    dictionary_.size());
        if (err_ == Z_OK) {
          // And try to decode again
          err_ = inflate(&strm_, flush_);
        } else if (err_ == Z_DATA_ERROR) {
          // Both inflateSetDictionary() and inflate() return Z_DATA_ERROR.
          // Make it possible for After() to tell a bad dictionary from bad
          // input.
          err_ = Z_NEED_DICT;
        }
      }

      while (strm_.avail_in > 0 && mode_ == GUNZIP && err_ == Z_STREAM_END &&
             !reject_garbage_after_end_ && strm_.next_in[0] != 0x00) {
        // Bytes remain in input buffer. Perhaps this is another compressed
        // member in the same archive, or just trailing garbage.
        // Trailing zero bytes are okay, though, since they are frequently
        // used for padding.

        ResetStream();
        err_ = inflate(&strm_, flush_);
      }
      break;
    default:
      UNREACHABLE();
  }
}


void ZlibContext::SetBuffers(const char* in, uint32_t in_len,
                             char* out, uint32_t out_len) {
  strm_.avail_in = in_len;
  strm_.next_in = const_cast<Bytef*>(reinterpret_cast<const Bytef*>(in));
  strm_.avail_out = out_len;
  strm_.next_out = reinterpret_cast<Bytef*>(out);
}


void ZlibContext::SetFlush(int flush) {
  flush_ = flush;
}


void ZlibContext::GetAfterWriteOffsets(uint32_t* avail_in,
                                       uint32_t* avail_out) const {
  *avail_in = strm_.avail_in;
  *avail_out = strm_.avail_out;
}


CompressionError ZlibContext::ErrorForMessage(const char* message) const {
  if (strm_.msg != nullptr)
    message = strm_.msg;

  return CompressionError { message, ZlibStrerror(err_), err_ };
}


CompressionError ZlibContext::GetErrorInfo() const {
  // Acceptable error states depend on the type of zlib stream.
  switch (err_) {
  case Z_OK:
  case Z_BUF_ERROR:
    if (strm_.avail_out != 0 && flush_ == Z_FINISH) {
      return ErrorForMessage("unexpected end of file");
    }
  case Z_STREAM_END:
    // normal statuses, not fatal
    break;
  case Z_NEED_DICT:
    if (dictionary_.empty())
      return ErrorForMessage("Missing dictionary");
    else
      return ErrorForMessage("Bad dictionary");
  default:
    // something else.
    return ErrorForMessage("Zlib error");
  }

  return CompressionError {};
}


CompressionError ZlibContext::ResetStream() {
  // deflateReset() is deflateEnd + deflateInit: a new stream. gzip emits a
  // wrapper header on the first write; those bytes cannot be taken back, so
  // refuse reset once an incomplete gzip member has emitted output.
  // zlib-wrapped deflate still allows reset after flush: callers discard the
  // first member (test-zlib-dictionary.js). Raw deflate has no wrapper header,
  // so flush+reset still concatenates.
  if (mode_ == GZIP && !stream_complete_ && output_emitted_) {
    return CompressionError(
        "Cannot reset a gzip stream with an incomplete member; end the "
        "stream or start a new gzip compressor",
        "ERR_ZLIB_INCOMPLETE_FRAME",
        Z_STREAM_ERROR);
  }

  bool first_init_call = InitZlib();
  if (first_init_call && err_ != Z_OK) {
    return ErrorForMessage("Failed to init stream before reset");
  }

  err_ = Z_OK;

  switch (mode_) {
    case DEFLATE:
    case DEFLATERAW:
    case GZIP:
      err_ = deflateReset(&strm_);
      break;
    case INFLATE:
    case INFLATERAW:
    case GUNZIP:
      err_ = inflateReset(&strm_);
      break;
    default:
      break;
  }

  if (err_ != Z_OK)
    return ErrorForMessage("Failed to reset stream");

  stream_complete_ = true;
  output_emitted_ = false;
  return SetDictionary();
}

void ZlibContext::Init(int level,
                       int window_bits,
                       int mem_level,
                       int strategy,
                       bool reject_garbage_after_end,
                       std::vector<unsigned char>&& dictionary) {
  // Set allocation functions
  strm_.zalloc = CompressionStreamMemoryOwner::AllocForZlib;
  strm_.zfree = CompressionStreamMemoryOwner::FreeForZlib;
  strm_.opaque =
      CompressionStream<ZlibContext>::AllocatorOpaquePointerForContext(this);

  if (!((window_bits == 0) &&
        (mode_ == INFLATE ||
         mode_ == GUNZIP ||
         mode_ == UNZIP))) {
    CHECK(
        (window_bits >= Z_MIN_WINDOWBITS && window_bits <= Z_MAX_WINDOWBITS) &&
        "invalid windowBits");
  }

  CHECK((level >= Z_MIN_LEVEL && level <= Z_MAX_LEVEL) &&
    "invalid compression level");

  CHECK((mem_level >= Z_MIN_MEMLEVEL && mem_level <= Z_MAX_MEMLEVEL) &&
        "invalid memlevel");

  CHECK((strategy == Z_FILTERED || strategy == Z_HUFFMAN_ONLY ||
         strategy == Z_RLE || strategy == Z_FIXED ||
         strategy == Z_DEFAULT_STRATEGY) &&
        "invalid strategy");

  level_ = level;
  window_bits_ = window_bits;
  mem_level_ = mem_level;
  strategy_ = strategy;
  reject_garbage_after_end_ = reject_garbage_after_end;

  flush_ = Z_NO_FLUSH;

  err_ = Z_OK;
  stream_complete_ = true;
  output_emitted_ = false;

  if (mode_ == GZIP || mode_ == GUNZIP) {
    window_bits_ += 16;
  }

  if (mode_ == UNZIP) {
    window_bits_ += 32;
  }

  if (mode_ == DEFLATERAW || mode_ == INFLATERAW) {
    window_bits_ *= -1;
  }

  dictionary_ = std::move(dictionary);
}

bool ZlibContext::InitZlib() {
  Mutex::ScopedLock lock(mutex_);
  if (zlib_init_done_) {
    return false;
  }

  // If deflateInit2() fails with Z_VERSION_ERROR, msg remains uninitialized.
  // Initialize it here to avoid reading the uninitialized pointer during error
  // emission.
  strm_.msg = nullptr;

  switch (mode_) {
    case DEFLATE:
    case GZIP:
    case DEFLATERAW:
      err_ = deflateInit2(&strm_,
                          level_,
                          Z_DEFLATED,
                          window_bits_,
                          mem_level_,
                          strategy_);
      break;
    case INFLATE:
    case GUNZIP:
    case INFLATERAW:
    case UNZIP:
      err_ = inflateInit2(&strm_, window_bits_);
      break;
    default:
      UNREACHABLE();
  }

  if (err_ != Z_OK) {
    dictionary_.clear();
    mode_ = NONE;
    return true;
  }

  SetDictionary();
  zlib_init_done_ = true;
  return true;
}


CompressionError ZlibContext::SetDictionary() {
  if (dictionary_.empty())
    return CompressionError {};

  err_ = Z_OK;

  switch (mode_) {
    case DEFLATE:
    case DEFLATERAW:
      err_ = deflateSetDictionary(&strm_,
                                  dictionary_.data(),
                                  dictionary_.size());
      break;
    case INFLATERAW:
      // The other inflate cases will have the dictionary set when inflate()
      // returns Z_NEED_DICT in Process()
      err_ = inflateSetDictionary(&strm_,
                                  dictionary_.data(),
                                  dictionary_.size());
      break;
    default:
      break;
  }

  if (err_ != Z_OK) {
    return ErrorForMessage("Failed to set dictionary");
  }

  return CompressionError {};
}


CompressionError ZlibContext::SetParams(int level, int strategy) {
  bool first_init_call = InitZlib();
  if (first_init_call && err_ != Z_OK) {
    return ErrorForMessage("Failed to init stream before set parameters");
  }

  err_ = Z_OK;

  switch (mode_) {
    case DEFLATE:
    case DEFLATERAW:
      err_ = deflateParams(&strm_, level, strategy);
      break;
    default:
      break;
  }

  if (err_ != Z_OK && err_ != Z_BUF_ERROR) {
    return ErrorForMessage("Failed to set parameters");
  }

  return CompressionError {};
}


void BrotliContext::SetBuffers(const char* in, uint32_t in_len,
                               char* out, uint32_t out_len) {
  next_in_ = reinterpret_cast<const uint8_t*>(in);
  next_out_ = reinterpret_cast<uint8_t*>(out);
  avail_in_ = in_len;
  avail_out_ = out_len;
}


void BrotliContext::SetFlush(int flush) {
  flush_ = static_cast<BrotliEncoderOperation>(flush);
}


void BrotliContext::GetAfterWriteOffsets(uint32_t* avail_in,
                                         uint32_t* avail_out) const {
  *avail_in = avail_in_;
  *avail_out = avail_out_;
}


void BrotliEncoderContext::DoThreadPoolWork() {
  CHECK_EQ(mode_, BROTLI_ENCODE);
  CHECK(state_);
  const uint8_t* next_in = next_in_;
  last_result_ = BrotliEncoderCompressStream(state_.get(),
                                             flush_,
                                             &avail_in_,
                                             &next_in,
                                             &avail_out_,
                                             &next_out_,
                                             nullptr);
  next_in_ += next_in - next_in_;
}


void BrotliEncoderContext::Close() {
  state_.reset();
  prepared_dictionary_.reset();
  dictionary_.clear();
  params_.clear();
  mode_ = NONE;
}

CompressionError BrotliEncoderContext::Init(std::vector<uint8_t>&& dictionary) {
  brotli_alloc_func alloc = CompressionStreamMemoryOwner::AllocForBrotli;
  brotli_free_func free = CompressionStreamMemoryOwner::FreeForZlib;
  void* opaque =
      CompressionStream<BrotliEncoderContext>::AllocatorOpaquePointerForContext(
          this);

  // Clean up any previous dictionary state before re-initializing.
  prepared_dictionary_.reset();
  dictionary_.clear();
  params_.clear();

  state_.reset(BrotliEncoderCreateInstance(alloc, free, opaque));
  if (!state_) {
    return CompressionError("Could not initialize Brotli instance",
                            "ERR_ZLIB_INITIALIZATION_FAILED",
                            -1);
  }

  if (!dictionary.empty()) {
    // The dictionary data must remain valid for the lifetime of the prepared
    // dictionary, so take ownership via move.
    dictionary_ = std::move(dictionary);

    prepared_dictionary_.reset(
        BrotliEncoderPrepareDictionary(BROTLI_SHARED_DICTIONARY_RAW,
                                       dictionary_.size(),
                                       dictionary_.data(),
                                       BROTLI_MAX_QUALITY,
                                       alloc,
                                       free,
                                       opaque));
    if (!prepared_dictionary_) {
      return CompressionError("Failed to prepare brotli dictionary",
                              "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                              -1);
    }

    if (!BrotliEncoderAttachPreparedDictionary(state_.get(),
                                               prepared_dictionary_.get())) {
      return CompressionError("Failed to attach brotli dictionary",
                              "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                              -1);
    }
  }

  return CompressionError{};
}

CompressionError BrotliEncoderContext::ResetStream() {
  std::vector<uint8_t> dictionary = dictionary_;
  const auto params = params_;
  CompressionError err = Init(std::move(dictionary));
  if (err.IsError()) {
    return err;
  }
  for (const auto& entry : params) {
    err = SetParams(entry.first, entry.second);
    if (err.IsError()) {
      return err;
    }
  }
  return CompressionError{};
}

CompressionError BrotliEncoderContext::SetParams(int key, uint32_t value) {
  if (!BrotliEncoderSetParameter(state_.get(),
                                 static_cast<BrotliEncoderParameter>(key),
                                 value)) {
    return CompressionError("Setting parameter failed",
                            "ERR_BROTLI_PARAM_SET_FAILED",
                            -1);
  } else {
    RecordBrotliParam(&params_, key, value);
    return CompressionError {};
  }
}

CompressionError BrotliEncoderContext::GetErrorInfo() const {
  if (!last_result_) {
    return CompressionError("Compression failed",
                            "ERR_BROTLI_COMPRESSION_FAILED",
                            -1);
  } else {
    return CompressionError {};
  }
}


void BrotliDecoderContext::Close() {
  state_.reset();
  dictionary_.clear();
  params_.clear();
  mode_ = NONE;
}

void BrotliDecoderContext::DoThreadPoolWork() {
  CHECK_EQ(mode_, BROTLI_DECODE);
  CHECK(state_);
  const uint8_t* next_in = next_in_;
  last_result_ = BrotliDecoderDecompressStream(state_.get(),
                                               &avail_in_,
                                               &next_in,
                                               &avail_out_,
                                               &next_out_,
                                               nullptr);
  next_in_ += next_in - next_in_;
  if (last_result_ == BROTLI_DECODER_RESULT_ERROR) {
    error_ = BrotliDecoderGetErrorCode(state_.get());
    error_string_ = std::string("ERR_") + BrotliDecoderErrorString(error_);
  }
}

CompressionError BrotliDecoderContext::Init(std::vector<uint8_t>&& dictionary) {
  brotli_alloc_func alloc = CompressionStreamMemoryOwner::AllocForBrotli;
  brotli_free_func free = CompressionStreamMemoryOwner::FreeForZlib;
  void* opaque =
      CompressionStream<BrotliDecoderContext>::AllocatorOpaquePointerForContext(
          this);

  // Clean up any previous dictionary state before re-initializing.
  dictionary_.clear();
  params_.clear();

  state_.reset(BrotliDecoderCreateInstance(alloc, free, opaque));
  if (!state_) {
    return CompressionError("Could not initialize Brotli instance",
                            "ERR_ZLIB_INITIALIZATION_FAILED",
                            -1);
  }

  if (!dictionary.empty()) {
    // The dictionary data must remain valid for the lifetime of the decoder,
    // so take ownership via move.
    dictionary_ = std::move(dictionary);

    if (!BrotliDecoderAttachDictionary(state_.get(),
                                       BROTLI_SHARED_DICTIONARY_RAW,
                                       dictionary_.size(),
                                       dictionary_.data())) {
      return CompressionError("Failed to attach brotli dictionary",
                              "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                              -1);
    }
  }

  return CompressionError{};
}

CompressionError BrotliDecoderContext::ResetStream() {
  std::vector<uint8_t> dictionary = dictionary_;
  const auto params = params_;
  CompressionError err = Init(std::move(dictionary));
  if (err.IsError()) {
    return err;
  }
  for (const auto& entry : params) {
    err = SetParams(entry.first, entry.second);
    if (err.IsError()) {
      return err;
    }
  }
  return CompressionError{};
}

CompressionError BrotliDecoderContext::SetParams(int key, uint32_t value) {
  if (!BrotliDecoderSetParameter(state_.get(),
                                 static_cast<BrotliDecoderParameter>(key),
                                 value)) {
    return CompressionError("Setting parameter failed",
                            "ERR_BROTLI_PARAM_SET_FAILED",
                            -1);
  } else {
    RecordBrotliParam(&params_, key, value);
    return CompressionError {};
  }
}

CompressionError BrotliDecoderContext::GetErrorInfo() const {
  if (error_ != BROTLI_DECODER_NO_ERROR) {
    return CompressionError("Decompression failed",
                            error_string_.c_str(),
                            static_cast<int>(error_));
  } else if (flush_ == BROTLI_OPERATION_FINISH &&
             last_result_ == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
    // Match zlib's behaviour, as brotli doesn't have its own code for this.
    return CompressionError("unexpected end of file",
                            "Z_BUF_ERROR",
                            Z_BUF_ERROR);
  } else {
    return CompressionError {};
  }
}

void ZstdContext::SetBuffers(const char* in,
                             uint32_t in_len,
                             char* out,
                             uint32_t out_len) {
  input_.src = reinterpret_cast<const uint8_t*>(in);
  input_.size = in_len;
  input_.pos = 0;

  output_.dst = reinterpret_cast<uint8_t*>(out);
  output_.size = out_len;
  output_.pos = 0;
}

void ZstdContext::SetFlush(int flush) {
  flush_ = static_cast<ZSTD_EndDirective>(flush);
}

void ZstdContext::GetAfterWriteOffsets(uint32_t* avail_in,
                                       uint32_t* avail_out) const {
  *avail_in = input_.size - input_.pos;
  *avail_out = output_.size - output_.pos;
}

CompressionError ZstdContext::GetErrorInfo() const {
  if (error_ != ZSTD_error_no_error) {
    return CompressionError(error_string_.c_str(),
                            error_code_string_.c_str(),
                            static_cast<int>(error_));
  } else {
    return {};
  }
}

CompressionError ZstdCompressContext::SetParameter(int key, int value) {
  size_t result = ZSTD_CCtx_setParameter(
      cctx_.get(), static_cast<ZSTD_cParameter>(key), value);
  if (ZSTD_isError(result)) {
    return CompressionError(
        "Setting parameter failed", "ERR_ZSTD_PARAM_SET_FAILED", -1);
  }
  return {};
}

void ZstdCompressContext::Close() {
  cctx_.reset();
}

CompressionError ZstdCompressContext::Init(uint64_t pledged_src_size,
                                           std::string_view dictionary,
                                           bool) {
  pledged_src_size_ = pledged_src_size;
  frame_complete_ = true;
  frame_output_emitted_ = false;
  if (pledged_src_size == ZSTD_CONTENTSIZE_UNKNOWN) {
    consumed_src_size_.reset();
  } else {
    consumed_src_size_ = 0;
  }
#ifdef NODE_BUNDLED_ZSTD
  ZSTD_customMem custom_mem = {
      CompressionStreamMemoryOwner::AllocForBrotli,
      CompressionStreamMemoryOwner::FreeForZlib,
      CompressionStream<ZstdCompressContext>::AllocatorOpaquePointerForContext(
          this)};
  cctx_.reset(ZSTD_createCCtx_advanced(custom_mem));
#else
  cctx_.reset(ZSTD_createCCtx());
#endif
  if (!cctx_) {
    return CompressionError("Could not initialize zstd instance",
                            "ERR_ZLIB_INITIALIZATION_FAILED",
                            -1);
  }

  if (!dictionary.empty()) {
    size_t ret = ZSTD_CCtx_loadDictionary(
        cctx_.get(), dictionary.data(), dictionary.size());
    if (ZSTD_isError(ret)) {
      return CompressionError("Failed to load zstd dictionary",
                              "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                              -1);
    }
  }

  size_t result = ZSTD_CCtx_setPledgedSrcSize(cctx_.get(), pledged_src_size);
  if (ZSTD_isError(result)) {
    return CompressionError(
        "Could not set pledged src size", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  }
  return {};
}

CompressionError ZstdCompressContext::ResetStream() {
  // ZSTD_reset_session_only cancels unflushed internal data. Bytes that have
  // already been written out cannot be taken back, so refuse reset only when
  // the current incomplete frame has already emitted output.
  if (!frame_complete_ && frame_output_emitted_) {
    return CompressionError(
        "Cannot reset a zstd stream with an incomplete frame; end the frame "
        "or discard the output produced so far",
        "ERR_ZLIB_INCOMPLETE_FRAME",
        ZSTD_error_stage_wrong);
  }

  size_t result = ZSTD_CCtx_reset(cctx_.get(), ZSTD_reset_session_only);
  if (ZSTD_isError(result)) {
    const ZSTD_ErrorCode error = ZSTD_getErrorCode(result);
    return CompressionError(
        ZSTD_getErrorString(error), ZstdStrerror(error), error);
  }

  result = ZSTD_CCtx_setPledgedSrcSize(cctx_.get(), pledged_src_size_);
  if (ZSTD_isError(result)) {
    const ZSTD_ErrorCode error = ZSTD_getErrorCode(result);
    return CompressionError(
        ZSTD_getErrorString(error), ZstdStrerror(error), error);
  }

  if (pledged_src_size_ == ZSTD_CONTENTSIZE_UNKNOWN) {
    consumed_src_size_.reset();
  } else {
    consumed_src_size_ = 0;
  }
  frame_complete_ = true;
  frame_output_emitted_ = false;
  error_ = ZSTD_error_no_error;
  error_string_.clear();
  error_code_string_.clear();
  return {};
}

void ZstdCompressContext::DoThreadPoolWork() {
  // Zstd overrides a configured pledge when the first call uses ZSTD_e_end.
  size_t const input_pos = input_.pos;
  size_t const remaining =
      ZSTD_compressStream2(cctx_.get(), &output_, &input_, flush_);
  if (consumed_src_size_.has_value()) {
    *consumed_src_size_ += input_.pos - input_pos;
  }
  if (output_.pos > 0) {
    frame_output_emitted_ = true;
  }
  if (ZSTD_isError(remaining)) {
    error_ = ZSTD_getErrorCode(remaining);
    error_code_string_ = ZstdStrerror(error_);
    error_string_ = ZSTD_getErrorString(error_);
    frame_complete_ = false;
  } else if (remaining == 0 && flush_ == ZSTD_e_end) {
    frame_complete_ = true;
    frame_output_emitted_ = false;
    if (consumed_src_size_.has_value()) {
      uint64_t const consumed_src_size = *consumed_src_size_;
      consumed_src_size_.reset();
      if (consumed_src_size != pledged_src_size_) {
        error_ = ZSTD_error_srcSize_wrong;
        error_code_string_ = ZstdStrerror(error_);
        error_string_ = ZSTD_getErrorString(error_);
      }
    }
  } else {
    frame_complete_ = false;
  }
}

CompressionError ZstdDecompressContext::SetParameter(int key, int value) {
  size_t result = ZSTD_DCtx_setParameter(
      dctx_.get(), static_cast<ZSTD_dParameter>(key), value);
  if (ZSTD_isError(result)) {
    return CompressionError(
        "Setting parameter failed", "ERR_ZSTD_PARAM_SET_FAILED", -1);
  }
  return {};
}

void ZstdDecompressContext::Close() {
  dctx_.reset();
}

CompressionError ZstdDecompressContext::Init(uint64_t pledged_src_size,
                                             std::string_view dictionary,
                                             bool reject_garbage_after_end) {
  frame_complete_ = false;
  decoding_frame_after_complete_ = false;
  reject_garbage_after_end_ = reject_garbage_after_end;
  ignoring_trailing_input_ = false;
  frame_prefix_size_ = 0;
  possible_frame_types_ = 0;

#ifdef NODE_BUNDLED_ZSTD
  ZSTD_customMem custom_mem = {
      CompressionStreamMemoryOwner::AllocForBrotli,
      CompressionStreamMemoryOwner::FreeForZlib,
      CompressionStream<
          ZstdDecompressContext>::AllocatorOpaquePointerForContext(this)};
  dctx_.reset(ZSTD_createDCtx_advanced(custom_mem));
#else
  dctx_.reset(ZSTD_createDCtx());
#endif
  if (!dctx_) {
    return CompressionError("Could not initialize zstd instance",
                            "ERR_ZLIB_INITIALIZATION_FAILED",
                            -1);
  }

  if (!dictionary.empty()) {
    size_t ret = ZSTD_DCtx_loadDictionary(
        dctx_.get(), dictionary.data(), dictionary.size());
    if (ZSTD_isError(ret)) {
      return CompressionError("Failed to load zstd dictionary",
                              "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                              -1);
    }
  }
  return {};
}

CompressionError ZstdDecompressContext::ResetStream() {
  const size_t result = ZSTD_DCtx_reset(dctx_.get(), ZSTD_reset_session_only);
  if (ZSTD_isError(result)) {
    const ZSTD_ErrorCode error = ZSTD_getErrorCode(result);
    return CompressionError(
        ZSTD_getErrorString(error), ZstdStrerror(error), error);
  }

  frame_complete_ = false;
  decoding_frame_after_complete_ = false;
  ignoring_trailing_input_ = false;
  frame_prefix_size_ = 0;
  possible_frame_types_ = 0;
  error_ = ZSTD_error_no_error;
  error_string_.clear();
  error_code_string_.clear();
  return {};
}

void ZstdDecompressContext::DoThreadPoolWork() {
  if (ignoring_trailing_input_) {
    return;
  }

  // The JavaScript processing loop retries with an empty input buffer when the
  // previous call filled the output buffer. Avoid interpreting that retry as
  // the beginning of a new, incomplete frame.
  if (frame_complete_ && input_.size == 0) {
    return;
  }

  do {
    if (frame_complete_) {
      decoding_frame_after_complete_ = true;
      frame_prefix_size_ = 0;
      possible_frame_types_ = 0b11;
    }

    if (decoding_frame_after_complete_ && frame_prefix_size_ < 4) {
      static constexpr uint8_t zstd_magic[] = {0x28, 0xb5, 0x2f, 0xfd};
      static constexpr uint8_t skippable_magic[] = {0x50, 0x2a, 0x4d, 0x18};
      const auto* data = static_cast<const uint8_t*>(input_.src);
      size_t input_prefix_offset = 0;

      while (frame_prefix_size_ < 4 &&
             input_.pos + input_prefix_offset < input_.size) {
        const size_t index = frame_prefix_size_;
        const uint8_t byte = data[input_.pos + input_prefix_offset];
        if (byte != zstd_magic[index]) {
          possible_frame_types_ &= ~0b01;
        }
        if ((index == 0 && (byte & 0xf0) != skippable_magic[0]) ||
            (index != 0 && byte != skippable_magic[index])) {
          possible_frame_types_ &= ~0b10;
        }
        frame_prefix_size_++;
        input_prefix_offset++;
      }

      if (possible_frame_types_ == 0) {
        frame_complete_ = true;
        decoding_frame_after_complete_ = false;
        if (reject_garbage_after_end_) {
          error_ = ZSTD_error_GENERIC;
          error_code_string_ = "ERR_TRAILING_JUNK_AFTER_STREAM_END";
          error_string_ =
              "Trailing junk found after the end of the compressed stream";
        } else {
          ignoring_trailing_input_ = true;
        }
        return;
      }
    }

    const size_t ret = ZSTD_decompressStream(dctx_.get(), &output_, &input_);
    if (ZSTD_isError(ret)) {
      frame_complete_ = false;
      error_ = ZSTD_getErrorCode(ret);
      error_code_string_ = ZstdStrerror(error_);
      error_string_ = ZSTD_getErrorString(error_);
      return;
    }

    frame_complete_ = ret == 0;
    if (frame_complete_) {
      decoding_frame_after_complete_ = false;
    }
  } while (frame_complete_ && input_.pos < input_.size &&
           output_.pos < output_.size);
}

CompressionError ZstdDecompressContext::GetErrorInfo() const {
  CompressionError error = ZstdContext::GetErrorInfo();
  if (error.IsError()) {
    return error;
  }

  if (flush_ == ZSTD_e_end && !frame_complete_ && input_.pos == input_.size &&
      output_.pos < output_.size) {
    if (decoding_frame_after_complete_) {
      if (frame_prefix_size_ < 4) {
        if (reject_garbage_after_end_) {
          return CompressionError(
              "Trailing junk found after the end of the compressed stream",
              "ERR_TRAILING_JUNK_AFTER_STREAM_END",
              -1);
        }
        return {};
      }
    }
    return CompressionError(
        "unexpected end of file", "Z_BUF_ERROR", Z_BUF_ERROR);
  }

  return {};
}


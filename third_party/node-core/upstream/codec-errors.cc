#define ZLIB_ERROR_CODES(V)      \
  V(Z_OK)                        \
  V(Z_STREAM_END)                \
  V(Z_NEED_DICT)                 \
  V(Z_ERRNO)                     \
  V(Z_STREAM_ERROR)              \
  V(Z_DATA_ERROR)                \
  V(Z_MEM_ERROR)                 \
  V(Z_BUF_ERROR)                 \
  V(Z_VERSION_ERROR)             \

inline const char* ZlibStrerror(int err) {
#define V(code) if (err == code) return #code;
  ZLIB_ERROR_CODES(V)
#undef V
  return "Z_UNKNOWN_ERROR";
}

#define ZSTD_ERROR_CODES(V)                                                    \
  V(ZSTD_error_no_error)                                                       \
  V(ZSTD_error_GENERIC)                                                        \
  V(ZSTD_error_prefix_unknown)                                                 \
  V(ZSTD_error_version_unsupported)                                            \
  V(ZSTD_error_frameParameter_unsupported)                                     \
  V(ZSTD_error_frameParameter_windowTooLarge)                                  \
  V(ZSTD_error_corruption_detected)                                            \
  V(ZSTD_error_checksum_wrong)                                                 \
  V(ZSTD_error_literals_headerWrong)                                           \
  V(ZSTD_error_dictionary_corrupted)                                           \
  V(ZSTD_error_dictionary_wrong)                                               \
  V(ZSTD_error_dictionaryCreation_failed)                                      \
  V(ZSTD_error_parameter_unsupported)                                          \
  V(ZSTD_error_parameter_combination_unsupported)                              \
  V(ZSTD_error_parameter_outOfBound)                                           \
  V(ZSTD_error_tableLog_tooLarge)                                              \
  V(ZSTD_error_maxSymbolValue_tooLarge)                                        \
  V(ZSTD_error_maxSymbolValue_tooSmall)                                        \
  V(ZSTD_error_stabilityCondition_notRespected)                                \
  V(ZSTD_error_stage_wrong)                                                    \
  V(ZSTD_error_init_missing)                                                   \
  V(ZSTD_error_memory_allocation)                                              \
  V(ZSTD_error_workSpace_tooSmall)                                             \
  V(ZSTD_error_dstSize_tooSmall)                                               \
  V(ZSTD_error_srcSize_wrong)                                                  \
  V(ZSTD_error_dstBuffer_null)                                                 \
  V(ZSTD_error_noForwardProgress_destFull)                                     \
  V(ZSTD_error_noForwardProgress_inputEmpty)

inline const char* ZstdStrerror(int err) {
#define V(code)                                                                \
  if (err == code) return #code;
  ZSTD_ERROR_CODES(V)
#undef V
  return "ZSTD_error_GENERIC";
}


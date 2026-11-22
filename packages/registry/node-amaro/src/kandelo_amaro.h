#ifndef KANDELO_AMARO_H
#define KANDELO_AMARO_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct kandelo_amaro_result kandelo_amaro_result;
enum { KANDELO_AMARO_OK=0, KANDELO_AMARO_DIAGNOSTIC=1,
       KANDELO_AMARO_WIRE_ERROR=2, KANDELO_AMARO_RESOURCE_ERROR=3,
       KANDELO_AMARO_PANIC=4 };
uint32_t kandelo_amaro_abi_version(void);
/* Private wire protocol, not a JavaScript option converter. Successful JSON
 * encodes the original code/map fields (null map means JS undefined); diagnostic
 * JSON retains the original first diagnostic's complete serialized fields.
 * Other statuses carry UTF-8 failure text. Keep the module loaded until release.
 */
int kandelo_amaro_transform(const uint8_t *, size_t, const uint8_t *, size_t,
                           kandelo_amaro_result **);
const uint8_t *kandelo_amaro_result_bytes(const kandelo_amaro_result *, size_t *);
int kandelo_amaro_result_release(kandelo_amaro_result *);
#ifdef __cplusplus
}
#endif
#endif

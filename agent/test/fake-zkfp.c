/* A stand-in for libzkfp, matching the C API the agent binds to.
 * Not a simulator — just enough to prove the bindings marshal correctly. */
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

static int inited = 0;
static int captures = 0;

int ZKFPM_Init(void) { inited = 1; return 0; }
int ZKFPM_Terminate(void) { inited = 0; return 0; }
int ZKFPM_GetDeviceCount(void) { return 1; }
void *ZKFPM_OpenDevice(int index) { (void)index; return (void *)0xBEEF; }
int ZKFPM_CloseDevice(void *h) { (void)h; return 0; }

int ZKFPM_GetParameters(void *h, int code, uint8_t *value, uint32_t *size) {
  (void)h;
  uint32_t v = (code == 1) ? 640 : (code == 2) ? 480 : 0;
  if (!value || !size || *size < 4) return -5;
  memcpy(value, &v, 4);
  *size = 4;
  return 0;
}

/* Every third call has "no finger", so the retry loop gets exercised. */
int ZKFPM_AcquireFingerprint(void *h, uint8_t *image, uint32_t imageSize,
                             uint8_t *tmpl, uint32_t *tlen) {
  (void)h;
  if (!image || imageSize != 640 * 480) return -5;
  if ((captures++ % 3) == 0) return -8;
  if (!tmpl || !tlen || *tlen < 64) return -5;
  for (uint32_t i = 0; i < 64; i++) tmpl[i] = (uint8_t)(i + captures);
  *tlen = 64;
  return 0;
}

static uint32_t db_ids[64];
static int db_n = 0;

void *ZKFPM_DBInit(void) { db_n = 0; return (void *)0xCAFE; }
int ZKFPM_DBFree(void *c) { (void)c; return 0; }
int ZKFPM_DBClear(void *c) { (void)c; db_n = 0; return 0; }
int ZKFPM_DBAdd(void *c, uint32_t fid, uint32_t size, uint8_t *tmpl) {
  (void)c;
  if (!tmpl || !size) return -5;
  if (db_n < 64) db_ids[db_n++] = fid;
  return 0;
}
int ZKFPM_DBDel(void *c, uint32_t fid) { (void)c; (void)fid; return 0; }
int ZKFPM_DBIdentify(void *c, uint8_t *tmpl, uint32_t size,
                     uint32_t *fid, uint32_t *score) {
  (void)c;
  if (!tmpl || !size || !fid || !score) return -5;
  if (!db_n) return -17;
  *fid = db_ids[0];
  *score = 88;
  return 0;
}
int ZKFPM_DBMatch(void *c, uint8_t *a, uint32_t alen, uint8_t *b, uint32_t blen) {
  (void)c;
  if (!a || !b || !alen || !blen) return -5;
  return 90;                       /* positive = same finger */
}
int ZKFPM_DBMerge(void *c, uint8_t *a, uint8_t *b, uint8_t *d,
                  uint8_t *out, uint32_t *olen) {
  (void)c;
  if (!a || !b || !d || !out || !olen || *olen < 96) return -5;
  for (uint32_t i = 0; i < 96; i++) out[i] = (uint8_t)(a[i % 64] ^ i);
  *olen = 96;
  return 0;
}

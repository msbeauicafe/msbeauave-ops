# Testing the ZKTeco bindings without a ZKTeco

`fake-zkfp.c` is a stand-in for `libzkfp`, exposing the same C functions the
agent binds to. It is not a simulator — it invents templates and always
matches — but it is enough to prove the bindings themselves: that every
prototype in `sdk.js` parses, that pointers and output parameters marshal both
ways, that the no-finger retry loop works, and that a three-scan enrolment
merges and then identifies.

That is the half of the fingerprint work that can be checked away from the
hardware. What it cannot tell you is whether ZKTeco's real signatures match
the ones written here; only a ZK9500 can say that, and `npm run selftest` at
the shop is what asks it.

    gcc -shared -fPIC -o /tmp/libzkfp.so fake-zkfp.c
    node -e "import('../sdk.js').then(async s => {
      console.log(await s.open({ zkfpPath: '/tmp/libzkfp.so' }))
    })"

Needs a koffi build for the machine you run it on:
`npm pack @koromix/koffi-linux-x64` unpacked into `node_modules/@koromix/`.
The shipped bundle carries the two Windows builds only.

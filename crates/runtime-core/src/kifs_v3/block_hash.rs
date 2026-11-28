//! SHA-256 over independent, fixed-size file blocks. Disk digests are the
//! same as the scalar implementation for every positive or sparse extent.
use super::{BLOCK_BYTES, Digest, Errno, Sha256};
use core::simd::u32x4 as Word;

const GROUP_BYTES: usize = 4 * BLOCK_BYTES;

// All file blocks have the same full-length SHA-256 padding chunk.
const PADDING_SCHEDULE: [u32; 64] = {
    let mut words = [0u32; 64];
    words[0] = 0x80000000;
    words[15] = (BLOCK_BYTES * 8) as u32;
    let mut i = 16;
    while i < words.len() {
        let x = words[i - 2];
        let y = words[i - 15];
        words[i] = (x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10))
            .wrapping_add(words[i - 7])
            .wrapping_add(y.rotate_right(7) ^ y.rotate_right(18) ^ (y >> 3))
            .wrapping_add(words[i - 16]);
        i += 1;
    }
    words
};


// Four rows of four words, one row per independent hash. Convert byte
// order and transpose so each vector holds a word from each file block.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
fn load_words(blocks: &[u8; GROUP_BYTES], at: usize) -> [Word; 4] {
    use core::arch::wasm32::{i8x16_shuffle, i32x4_shuffle, v128, v128_load};

    let row = |lane: usize| {
        let bytes = &blocks[at + lane * BLOCK_BYTES..][..16];
        // The enclosing function requires SIMD. Each lane exposes an
        // in-bounds 16-byte slice and the load permits unaligned addresses.
        unsafe {
            let value = v128_load(bytes.as_ptr().cast());
            i8x16_shuffle::<3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12>(value, value)
        }
    };
    let (a, b, c, d) = (row(0), row(1), row(2), row(3));
    let lo = i32x4_shuffle::<0, 4, 1, 5>(a, b);
    let hi = i32x4_shuffle::<2, 6, 3, 7>(a, b);
    let other_lo = i32x4_shuffle::<0, 4, 1, 5>(c, d);
    let other_hi = i32x4_shuffle::<2, 6, 3, 7>(c, d);
    [
        i32x4_shuffle::<0, 1, 4, 5>(lo, other_lo),
        i32x4_shuffle::<2, 3, 6, 7>(lo, other_lo),
        i32x4_shuffle::<0, 1, 4, 5>(hi, other_hi),
        i32x4_shuffle::<2, 3, 6, 7>(hi, other_hi),
    ].map(|value| {
        // WebAssembly reads these four lanes as native little-endian words.
        Word::from_array(unsafe { core::mem::transmute::<v128, [u32; 4]>(value) })
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn load_words(blocks: &[u8; GROUP_BYTES], at: usize) -> [Word; 4] {
    core::array::from_fn(|word| {
        Word::from_array(core::array::from_fn(|lane| {
            let start = lane * BLOCK_BYTES + at + word * 4;
            u32::from_be_bytes(blocks[start..start + 4].try_into().unwrap())
        }))
    })
}

#[cfg_attr(target_arch = "wasm32", target_feature(enable = "simd128"))]
#[optimize(speed)]
fn hash_four(blocks: &[u8; GROUP_BYTES]) -> [[u8; 32]; 4] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const IV: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let rotate = |word: Word, bits: u32| (word >> Word::splat(bits)) | (word << Word::splat(32 - bits));
    let mut state = IV.map(Word::splat);
    for chunk in 0..=BLOCK_BYTES / 64 {
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        macro_rules! round {
            ($word:expr, $constant:expr) => {{
                let first = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
                    + (g ^ (e & (f ^ g))) + Word::splat($constant) + $word;
                let second = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) | (c & (a | b)));
                (a, b, c, d, e, f, g, h) = (first + second, a, b, c, d + first, e, f, g);
            }};
        }
        if chunk == BLOCK_BYTES / 64 {
            for (word, constant) in PADDING_SCHEDULE.into_iter().zip(K) {
                round!(Word::splat(word), constant);
            }
        } else {
            let mut words = [Word::splat(0); 16];
            for (index, group) in words.chunks_exact_mut(4).enumerate() {
                group.copy_from_slice(&load_words(blocks, chunk * 64 + index * 16));
            }
            macro_rules! input_rounds {
                ($($slot:literal),+ $(,)?) => { $(round!(words[$slot], K[$slot]);)+ };
            }
            input_rounds!(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
            // Each group replaces the same sixteen schedule slots in order.
            // Keeping their indices constant lets the engine retain live words
            // in SIMD locals during the compression rounds.
            for constants in K[16..].chunks_exact(16) {
                macro_rules! schedule_rounds {
                    ($($slot:literal),+ $(,)?) => { $(
                        let x = words[($slot + 14) & 15];
                        let y = words[($slot + 1) & 15];
                        let word = (rotate(x, 17) ^ rotate(x, 19) ^ (x >> Word::splat(10)))
                            + words[($slot + 9) & 15]
                            + (rotate(y, 7) ^ rotate(y, 18) ^ (y >> Word::splat(3))) + words[$slot];
                        words[$slot] = word;
                        round!(word, constants[$slot]);
                    )+ };
                }
                schedule_rounds!(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
            }
        }
        for (word, running) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *word += running;
        }
    }
    let mut result = [[0; 32]; 4];
    for (index, word) in state.iter().enumerate() {
        for (lane, value) in word.to_array().into_iter().enumerate() {
            result[lane][4 * index..4 * index + 4].copy_from_slice(&value.to_be_bytes());
        }
    }
    result
}

pub(super) fn for_each_digest(
    bytes: &[u8],
    mut consume: impl FnMut(usize, [u8; 32]) -> Result<(), Errno>,
) -> Result<(), Errno> {
    debug_assert_eq!(bytes.len() % BLOCK_BYTES, 0);
    let (groups, tail) = bytes.as_chunks::<GROUP_BYTES>();
    for (index, group) in groups.iter().enumerate() {
        // The wasm32 kernel targets engines with SIMD128 support.
        #[cfg(target_arch = "wasm32")]
        let digests = unsafe { hash_four(group) };
        #[cfg(not(target_arch = "wasm32"))]
        let digests = hash_four(group);
        for (lane, digest) in digests.into_iter().enumerate() {
            consume(index * 4 + lane, digest)?;
        }
    }
    for (index, block) in tail.chunks_exact(BLOCK_BYTES).enumerate() {
        consume(groups.len() * 4 + index, Sha256::digest(block).into())?;
    }
    Ok(())
}

#[test]
fn grouped_payload_digests_match_scalar_and_keep_lane_order() {
    let mut input = [0; 11 * BLOCK_BYTES];
    let mut random = 73493u32;
    for byte in &mut input[BLOCK_BYTES..] {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        *byte = random as u8;
    }
    let expected: [[u8; 32]; 11] = core::array::from_fn(|index| {
        Sha256::digest(&input[index * BLOCK_BYTES..(index + 1) * BLOCK_BYTES]).into()
    });
    for lane in 0..4 {
        let at = lane * BLOCK_BYTES + lane * 71;
        input[at] ^= 1;
        let mut visits = 0;
        for_each_digest(&input, |index, digest| {
            assert_eq!(index, visits);
            visits += 1;
            assert_eq!(digest != expected[index], index == lane);
            assert_eq!(digest[..], Sha256::digest(&input[index * BLOCK_BYTES..(index + 1) * BLOCK_BYTES])[..]);
            Ok(())
        }).unwrap();
        assert_eq!(visits, expected.len());
        input[at] ^= 1;
    }
}

/**
 * 转写片段的拼接与重叠去重。
 *
 * 录音按静音切段后逐段送去识别，相邻片段刻意保留一段重叠（默认 1.5 秒），
 * 拼接时要把重叠部分去掉，否则同一句话会在结果里出现两遍。
 *
 * 难点在于识别结果并不逐字稳定：同一段音频两次识别可能给出同音不同字的结果
 * （「根因」被听成「根音」），因此重叠判定按重叠长度容忍少量差异字数，
 * 而不是要求逐字相同。
 */

const PUNCT_RE = /[，。、？！；：""''（）《》\s,.?!;:'"()\-—…·]/;

/** 去掉标点与空白，并记录每个字符在原串中的位置，便于回填 */
function normalizeWithMap(text) {
  let norm = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (!PUNCT_RE.test(text[i])) {
      norm += text[i];
      map.push(i);
    }
  }
  return { norm, map };
}

/**
 * 重叠越长可容忍的差异字越多，上限 2 个字。
 * 阈值按重叠长度的 15% 向下取整、至少 1 字，既能容纳同音字，又不会把
 * 「分布式事务应该怎么做」和「分布式缓存应该怎么」判成同一句话。
 */
function allowedDiff(k) {
  return Math.min(2, Math.max(1, Math.floor(k * 0.15)));
}

/**
 * 拼接两段相邻片段的转写结果：找 a 的尾部与 b 的头部之间的重叠并去重。
 * 从最长的重叠往回试，命中即从重叠的最后一个字之后开始保留 b，标点随之前的部分一起丢弃。
 */
function mergeWithOverlapDedupe(a, b) {
  if (!a) return b;
  if (!b) return a;

  const { norm: na } = normalizeWithMap(a);
  const { norm: nb, map: mapB } = normalizeWithMap(b);
  const headLen = Math.min(nb.length, 60);
  const maxK = Math.min(na.length, 45);

  for (let k = maxK; k >= 4; k--) {
    const start = na.length - k;
    const maxDiff = allowedDiff(k);
    // 重叠的末字必须相同：否则只是碰巧近似的两句话（「怎么做」与「怎么选」）
    const lastChar = na[na.length - 1];
    for (let pos = 0; pos + k <= headLen; pos++) {
      if (nb[pos + k - 1] !== lastChar) continue;
      let diff = 0;
      for (let i = 0; i < k; i++) {
        if (na[start + i] !== nb[pos + i] && ++diff > maxDiff) break;
      }
      if (diff <= maxDiff) {
        // 重叠的最后一个字在 b 中的位置，其后即新内容
        const rest = b.slice(mapB[pos + k - 1] + 1);
        // 剩下的只有标点说明两段完全重合，直接沿用 a，避免拼出重复的句末标点
        return rest && normalizeWithMap(rest).norm ? a + rest : a;
      }
    }
  }
  return a + b;
}

module.exports = { mergeWithOverlapDedupe, normalizeWithMap, allowedDiff };

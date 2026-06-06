const RRF_K = 60;

export function reciprocalRankFusion(rankings: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const id = ranking[i]!;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
  }
  return scores;
}

from __future__ import annotations

RRF_K = 60


def reciprocal_rank_fusion(rankings: list[list[str]]) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for i, key in enumerate(ranking):
            scores[key] = scores.get(key, 0.0) + 1 / (RRF_K + i + 1)
    return scores

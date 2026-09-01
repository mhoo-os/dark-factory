# Factory quality and cost metrics
`factory/metrics.py` aggregates normalized run and evaluator observations; it
does not parse logs or retain raw trace content. Reports cover quality, fixes,
terminal causes, trajectory findings, tokens/cost/time, reliability incidents,
and merge outcomes by repository/profile/work type/model/risk cohort. Comparisons
require minimum sample and cost-completeness thresholds, bind exact evidence and
routing digests, and produce report-only recommendations. Adaptive routing and
authority changes remain outside this contract.

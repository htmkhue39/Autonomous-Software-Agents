# Local experimental evidence and limitations

This folder contains **sanitized, nonsecret summaries**, not the original raw Deliveroo.js game logs. The original runtime artifacts were produced on the student's Mac and must be kept privately. Scores below are **agent-observed**, not official tournament rankings.

## Performance: randomized-order evacuation ablation

Two configurations used the same cooperative (`bubble` BDI + `milktea` LLM) gameplay code. **C0** disables automatic LLM post-delivery evacuation; **C1** enables it. Each condition ran 10 trials, each 180 seconds with a fresh game server on `oval_counterclockwise`. The order was randomized within balanced C0/C1 blocks using scheduling seed `20261112`. The scheduling seed **does not** fix the game-world random seed. The LLM used local Ollama/Qwen with `LLM_MODE=json`; BDI movement used A* for this experiment.

| Metric (per round) | C0: evacuation off | C1: evacuation on |
| --- | ---: | ---: |
| Valid trials | 10/10 | 10/10 |
| Mean observed team score | 243.7 | 376.3 |
| Median observed team score | 239.0 | 377.5 |
| Mean delivered parcels | 16.1 | 26.9 |
| Mean teammate-related BDI congestion failures | 4.7 | 1.7 |
| Successful LLM delivery-tile evacuations | 0 (disabled) | 44/44 attempts |

The observed mean score difference was **+132.6 points (+54.4%)**. A two-sided **Welch independent-samples test** gives an approximate 95% confidence interval **[+28.6, +236.6]** points and **p≈0.0154**. The results are promising within this experimental setting but do not establish an invariant effect across maps or environments. The test is exploratory (the intervention was motivated by earlier results), the game worlds were **not matched or seeded**, and there may be additional variability from LLM inference time, parcel placement, and other agents. The observed reduction in teammate congestion is consistent with—not definitive proof of—the proposed mechanism.

The raw numeric trial values are included in [`../evidence/ablation_trials.csv`](../evidence/ablation_trials.csv) and the independently calculated summary is in [`../evidence/ablation_statistics.json`](../evidence/ablation_statistics.json). These values were transcribed from the **student-provided real Mac terminal output and `ablation-results.csv`**, not recovered from the uploaded code ZIP (which did not contain the ablation-results directory). Do not describe them as reproduced in this sandbox.

## Functional validation: real local game

The uploaded code ZIP included the real local `course-validation-results/2026-11-13T06-59-41-837Z/scenarios.csv`, from which the sanitized [`../evidence/local_validation_scenarios.csv`](../evidence/local_validation_scenarios.csv) was derived. Its four scenarios all passed:

| Scenario | Verified local checks | Evidence |
| --- | ---: | --- |
| `bdi_pddl` | 11/11 | One BDI intention, external PDDL call and success |
| `llm_objective` | 13/13 | LLM invoked tools and confirmed one delivery |
| `cooperation` | 16/16 | Two independent players, coordination messages, merged beliefs, deliveries and evacuation |
| `objective_replace` | 20/20 | Two objective starts and safe replacement with real game evidence |

**Total: 60/60 checks across four local scenarios.** The results show functional readiness in the local Deliveroo.js environment, **not** official Challenge 1/2 certification. The validation scenario duration is a maximum window; it should not be compared against the fixed-length performance scores.

## Security and provenance

- Original source upload: `Autonomous-Software-Agents(3).zip` (supplied by the user). The upload contained a `.env`, `node_modules`, Git metadata, and raw logs, all **intentionally excluded** from this release.
- The final source files, evidence data and report are bundled into the release ZIP. No private JWTs or raw game logs are included.
- Runtime manifests may contain local paths, host/agent identifiers, and other metadata; review original logs before sharing anything publicly.
- A reproducible run from a new checkout must be performed on a networked Mac/Linux computer with the official game server, Ollama, and online PDDL availability. The sandbox cannot validate those external services.

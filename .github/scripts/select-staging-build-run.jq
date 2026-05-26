def real_run:
  .conclusion != "skipped";

def newest_first:
  sort_by(.createdAt // "") | reverse;

def latest_real_run:
  [newest_first[] | select(real_run)][0] // null;

latest_real_run as $run |
{
  state: (
    if $run == null then
      if length == 0 then
        "no_runs"
      else
        "only_skipped"
      end
    elif ($run.status // "") == "completed" and ($run.conclusion // "") == "success" then
      "real_success"
    elif ($run.status // "") == "completed" then
      "real_failed"
    else
      "real_in_progress"
    end
  ),
  run_id: ($run.databaseId // ""),
  status: ($run.status // ""),
  conclusion: ($run.conclusion // ""),
  total_count: length,
  real_count: ([.[] | select(real_run)] | length),
  skipped_count: ([.[] | select(.conclusion == "skipped")] | length),
  skipped_run_ids: ([newest_first[] | select(.conclusion == "skipped") | .databaseId] | .[0:5])
}

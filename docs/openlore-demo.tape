# Reproduces docs/openlore-demo.gif with charmbracelet/vhs (https://github.com/charmbracelet/vhs).
#
# The hero GIF is an unedited recording of the PUBLISHED `openlore` (v2.1.6, installed from npm —
# not a local build) on a fresh clone of a real public repo: BurntSushi/ripgrep. Every line in the
# GIF is real output. Nothing is narrated, sped up, or re-typed.
#
# The four beats:
#   1. `openlore install`              — wires the agent surfaces, then indexes the repo live:
#                                        235 files → 2,978 functions / 4,329 call edges in ~14s.
#   2. `openlore orient '…'`           — the functions a task touches, in one deterministic call.
#   3. `openlore review --base HEAD~1` — a real committed hub change: `unwrap_switch` gained a
#                                        parameter, so 39 callers may be stale. No LLM.
#   4. `openlore prove --estimate`     — the payoff projected from this repo's own graph (an
#                                        ESTIMATE, labeled as one; the MEASURED agent benchmark in
#                                        the README's Value Scorecard is −26% round-trips).
#
# Reproduce (~2 min, no API key):
#
#   brew install vhs gifsicle                  # vhs needs ffmpeg + ttyd
#   npm i -g --prefix /tmp/openlore-demo-bin openlore
#   git clone --depth 30 https://github.com/BurntSushi/ripgrep /tmp/openlore-demo/ripgrep
#   cd /tmp/openlore-demo/ripgrep
#   # the hub change beat 3 reports on — a real signature edit, committed:
#   perl -0pi -e 's/fn unwrap_switch\(self\) -> bool \{/fn unwrap_switch(self, flag_name: &str) -> bool {/' \
#     crates/core/flags/mod.rs
#   git commit -qam 'flags: pass the flag name into unwrap_switch'
#   vhs docs/openlore-demo.tape                          # writes /tmp/openlore-demo.gif
#   gifsicle -O3 --lossy=60 --colors 128 /tmp/openlore-demo.gif -o docs/openlore-demo.gif
#
# Verify before committing: a GIF reads as one frame in most viewers — extract real frames with
#   ffmpeg -ss <sec> -i docs/openlore-demo.gif -vframes 1 frame.png
# and check that beat 1 ends on "✓ Index built" (raise the Sleep below if your machine is slower).

Output "/tmp/openlore-demo.gif"

Set Shell "bash"
Set FontSize 16
Set Width 1420
Set Height 740
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 20ms

Hide
Type "cd /tmp/openlore-demo/ripgrep && export PATH=/tmp/openlore-demo-bin/bin:$PATH && export PS1='❯ ' && clear"
Enter
Sleep 500ms
Show

# 1. One command: wire the agent + index the repo. Real static analysis, live, no API key.
Sleep 600ms
Type "openlore install"
Enter
Sleep 21s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# 2. Memory — the code a task touches, in one deterministic call.
Sleep 500ms
Type "openlore orient 'search inside compressed gzip files'"
Enter
Sleep 4s

Hide
Type "clear"
Enter
Sleep 300ms
Show

# 3. Governance — a signature changed; 39 callers may be stale. No LLM, no API key.
Sleep 500ms
Type "openlore review --base HEAD~1"
Enter
Sleep 4500ms

Hide
Type "clear"
Enter
Sleep 300ms
Show

# 4. Proof — the payoff projected from this repo's own graph (labeled an estimate).
Sleep 500ms
Type "openlore prove --estimate"
Enter
Sleep 5s

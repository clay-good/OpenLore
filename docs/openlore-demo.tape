# Reproduces the flow in docs/openlore-demo.gif with charmbracelet/vhs (https://github.com/charmbracelet/vhs).
#
# The hero GIF is a real terminal recording of the full lifecycle on a large real Rust repo —
# no edits, no narration. `prove --estimate` is a DETERMINISTIC per-repo projection, so the
# headline "−84% cost / −82% round-trips" is that repo's number; yours will differ (the MEASURED
# agent benchmark in the README's Value Scorecard is −26% round-trips). Every line below is real
# openlore output — nothing is faked.
#
# Setup (substitute your own Rust checkout for <REPO>; the GIF used a ~5k-function one):
#   npm i -g openlore                                   # v2.1.4+ (the four-beat lifecycle)
#   git clone --depth 1 https://github.com/BurntSushi/ripgrep /tmp/demo-repo   # any real Rust repo
#   brew install vhs                                    # needs ffmpeg + ttyd
#   # blast-radius needs an uncommitted edit to a hub function — make a small one to a
#   # frequently-called fn in /tmp/demo-repo before recording (the Hide block below is a placeholder).
#   vhs docs/openlore-demo.tape                         # writes /tmp/openlore-demo.gif

Output "/tmp/openlore-demo.gif"

Set Shell "bash"
Set FontSize 17
Set Width 1240
Set Height 680
Set Padding 22
Set Theme "Dracula"
Set TypingSpeed 22ms

Hide
Type "cd /tmp/demo-repo && export PS1='❯ ' && clear"
Enter
Show

# 1. Set up — one command, no API key. Static analysis indexes the whole repo.
Sleep 500ms
Type "openlore install"
Enter
Sleep 6000ms

Hide
Type "clear"
Enter
Show

# 2. Memory — one deterministic call finds the code a task touches.
Sleep 400ms
Type "openlore orient --task 'enforce the rate limit'"
Enter
Sleep 4500ms

Hide
Type "clear"
Enter
Show

# 3. Governance — with an uncommitted edit to a hub, blast-radius flags the risk before commit.
Sleep 400ms
Type "openlore blast-radius"
Enter
Sleep 4000ms

Hide
Type "clear"
Enter
Show

# 4. Proof — prove --estimate projects the payoff on this repo (deterministic, no agent run).
Sleep 400ms
Type "openlore prove --estimate"
Enter
Sleep 4500ms

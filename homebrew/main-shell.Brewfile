# The deliberately small base shell closure.
#
# Bash and its dependency closure are embedded because every shell boot needs
# them. Dash, Bzip2, and the first-party M4 remain independently lazy bottle
# trees. Homebrew's own source and runtime-support layer are separate package
# contracts; neither silently expands this base Brewfile.
tap "kandelo-dev/tap-core"

brew "kandelo-dev/tap-core/bash"
brew "kandelo-dev/tap-core/dash"
brew "kandelo-dev/tap-core/bzip2"
brew "kandelo-dev/tap-core/m4"

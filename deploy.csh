#!/bin/csh -f
#
# deploy.csh — Set up the Ska environment, then run deploy.py.
#
# All arguments are passed through to deploy.py, and its exit code is returned:
#     ./deploy.csh                         # all steps
#     ./deploy.csh --dry-run
#     ./deploy.csh --log-file /path/to/deploy.log      # typical cron use
#
# -f skips ~/.cshrc so cron and interactive runs get the same environment.

set SKA_ENVS = /proj/sot/ska3/flight/bin/ska_envs.csh
set MERIDIAN = $HOME/AXAFLIB/meridian

if (! -r $MERIDIAN/deploy.py) then
    echo "deploy.csh: deploy.py not found: $MERIDIAN/deploy.py" > /dev/stderr
    exit 2
endif

if (! -r $SKA_ENVS) then
    echo "deploy.csh: Ska setup script not found or not readable: $SKA_ENVS" > /dev/stderr
    exit 2
endif
source $SKA_ENVS
if (! $?SKA) then
    echo "deploy.csh: $SKA_ENVS did not set SKA" > /dev/stderr
    exit 2
endif

# Full path, so this works from any directory (and from a copy of this script
# elsewhere). Relative paths in the arguments are relative to the caller's directory.
python $MERIDIAN/deploy.py $argv:q
exit $status

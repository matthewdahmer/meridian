#!/bin/csh -f
#
# deploy.csh — Set up the Ska environment, then run deploy.py.
#
# All arguments are passed through to deploy.py, and its exit code is returned:
#     ./deploy.csh                         # all steps
#     ./deploy.csh --dry-run
#     ./deploy.csh --log-file /path/to/deploy.log      # typical cron use
#
# The Ska setup script defaults to SKA_ENVS below. Override it per run or in the
# crontab with:   setenv SKA_ENVS_SCRIPT /path/to/ska_envs.csh
#
# -f skips ~/.cshrc so cron and interactive runs get the same environment.

set SKA_ENVS = /proj/sot/ska3/flight/bin/ska_envs.csh   # confirm on the deployment host
if ($?SKA_ENVS_SCRIPT) set SKA_ENVS = "$SKA_ENVS_SCRIPT"

if (! -r "$SKA_ENVS") then
    echo "deploy.csh: Ska setup script not found or not readable: $SKA_ENVS" > /dev/stderr
    echo "deploy.csh: set SKA_ENVS_SCRIPT or edit SKA_ENVS in this file" > /dev/stderr
    exit 2
endif
source "$SKA_ENVS"
if (! $?SKA) then
    echo "deploy.csh: $SKA_ENVS did not set SKA" > /dev/stderr
    exit 2
endif

# Run from the directory holding this script, wherever it was called from.
cd "`dirname $0`"
python deploy.py $argv:q
exit $status

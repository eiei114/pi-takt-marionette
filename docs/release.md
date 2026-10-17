# Release

Release and npm publication workflows are disabled until the repository has a
trusted external authorization boundary for those privileged actions. The
current repository has no protected release environment or release ruleset, so
the branch-controlled workflow conditions are not sufficient authorization.

Do not create or push a `vX.Y.Z` tag expecting it to publish the package. This
repository currently has no automated or manual release path. An owner must
establish and verify the required GitHub protection outside this repository
before restoring any release or publication workflow. This repository does not
configure credentials, permissions, environments, or approval rules.

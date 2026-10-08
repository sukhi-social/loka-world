#!/bin/sh
# runner をホストに入れる。何度流しても同じ(再実行してよい)。ホストで、sudo の使える人が流す:
#   WORLD_BOX=rocky@HOST runner/install.sh
# 入れるもの: podman(dnf)、専用ユーザー lokarun、/run/loka-runner(tmpfiles.d)、
# lokarun の systemd ユーザーサービス loka-runner、ジョブの像 loka-job。
set -eu
BOX=${WORLD_BOX:?set WORLD_BOX to the SSH destination for the server}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STAGE=/tmp/loka-runner-src

rsync -az --delete "$HERE/" "$BOX:$STAGE/"
ssh "$BOX" "STAGE=$STAGE sh -s" <<'REMOTE'
set -eu
rpm -q podman >/dev/null 2>&1 || sudo dnf install -y podman
id lokarun >/dev/null 2>&1 || sudo useradd -m -s /bin/bash lokarun
sudo loginctl enable-linger lokarun
UID_L=$(id -u lokarun)
U="sudo -u lokarun env XDG_RUNTIME_DIR=/run/user/$UID_L"

# lokarun のジョブに CPU の上限をかけられるよう、cpu コントローラーを渡す(lokarun だけ)
sudo install -d /etc/systemd/system/user@$UID_L.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' | sudo tee /etc/systemd/system/user@$UID_L.service.d/delegate.conf >/dev/null
if ! grep -qw cpu /sys/fs/cgroup/user.slice/user-$UID_L.slice/user@$UID_L.service/cgroup.controllers 2>/dev/null; then
  sudo systemctl daemon-reload
  sudo systemctl restart user@$UID_L.service   # lokarun の manager だけ(runner はこのあと起こす)
fi

# world(uid/gid 1000)だけが入れる窓口の置き場
GID_W=$(id -g rocky)
echo "d /run/loka-runner 2750 lokarun $(id -gn rocky) -" | sudo tee /etc/tmpfiles.d/loka-runner.conf >/dev/null
sudo systemd-tmpfiles --create /etc/tmpfiles.d/loka-runner.conf

sudo install -d -o lokarun -g lokarun -m 755 /home/lokarun/runner /home/lokarun/.config/systemd/user
sudo install -o lokarun -g lokarun -m 644 "$STAGE/loka_runner.py" /home/lokarun/runner/loka_runner.py
sudo install -o lokarun -g lokarun -m 644 "$STAGE/loka-runner.service" /home/lokarun/.config/systemd/user/loka-runner.service

# ジョブの像(一度焼けば、中身が変わるまで要らない)
chmod -R a+rX "$STAGE"
if ! $U podman image exists loka-job; then
  (cd "$STAGE" && $U podman build -t loka-job -f Containerfile .)
fi

$U systemctl --user daemon-reload
$U systemctl --user enable loka-runner
$U systemctl --user restart loka-runner
sleep 2
$U systemctl --user is-active loka-runner
ls -l /run/loka-runner
REMOTE

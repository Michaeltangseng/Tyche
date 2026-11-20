#!/bin/sh
# 里程碑 0 实测用的假 Agent。
#
# 环境变量：
#   OUT     输出目录（必需）
#   LOOPS   主循环次数，每次 0.2 秒（默认 3）
#   ESCAPE  1 时额外用 perl setsid 派生一个脱离进程组的写进程（默认 0）
#
# 行为：输出 STARTED 并写 OUT/started；启动一个每 0.2 秒追加 OUT/bg 的后台循环
# （忽略 SIGTERM，用来验证监护程序的最后一步整组 SIGKILL）；主循环结束后输出
# FINAL-ANSWER 并退出。

set -u

OUT="${OUT:?OUT is required}"
LOOPS="${LOOPS:-3}"
ESCAPE="${ESCAPE:-0}"

mkdir -p "$OUT"
echo "STARTED"
: > "$OUT/started"

(
  trap '' TERM
  while true; do
    printf 'tick\n' >> "$OUT/bg"
    sleep 0.2
  done
) &

if [ "$ESCAPE" = "1" ]; then
  perl -e '
    use POSIX ();
    POSIX::setsid();
    $SIG{TERM} = "IGNORE";
    my $path = $ARGV[0];
    while (1) {
      open(my $fh, ">>", $path) or die "open: $!";
      print $fh "tick\n";
      close($fh);
      select(undef, undef, undef, 0.2);
    }
  ' "$OUT/escaped" </dev/null >/dev/null 2>&1 &
  echo $! > "$OUT/escaped.pid"
fi

i=0
while [ "$i" -lt "$LOOPS" ]; do
  sleep 0.2
  i=$((i + 1))
done

echo "FINAL-ANSWER"
exit 0

# hako(箱)

決まった root の下だけを見るファイルシステムと、その中だけで動くコンソール。Ruby の標準ライブラリだけ。
シロ(koe)の手として使う。root は `~/.shiro/hako/root`(`HAKO_ROOT` で変えられる)。

- 道は root の下しか通らない。`..` も symlink も、外に出るものは断る
- 消さない。`rm` も上書きも、前のものを `.trash/` に移す(`.trash/` と `.log/` は見せない・触らせない)
- 容量 200MB、一つのファイル 8MB、読み書きの返しは 8KB まで
- `run` は `sandbox-exec` の中: root の外へは書けない、root の中でも unlink はできない、network は無い、
  時間(既定 10 秒)と出力の上限、環境は最小(PATH/HOME=root/TMPDIR/LANG)
- 何をしたかは `.log/日付.jsonl` に

```
bin/hako ls [path] / cat path / write path (stdin | --content) / mkdir path / mv a b / rm path / usage
bin/hako run [--cwd d] [--timeout s] -- cmd args...    bin/hako run -c "sh の一行"
--json で機械向けの返し。--root DIR で箱を変える
ruby test_hako.rb
```

sandbox-exec は Apple が deprecated と言い続けているが、いまも動く。動かなくなったら、その日に別の箱(VM)を考える。

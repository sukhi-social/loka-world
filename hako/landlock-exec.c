#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fail(const char *action) {
  fprintf(stderr, "loka-sandbox: %s: %s\n", action, strerror(errno));
  return 125;
}

static int add_path_rule(int ruleset, const char *path, unsigned long long access, int required) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (!required && errno == ENOENT) return 0;
    return -1;
  }

  struct landlock_path_beneath_attr rule = {
    .allowed_access = access,
    .parent_fd = fd,
  };
  int result = syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  int saved_errno = errno;
  close(fd);
  errno = saved_errno;
  return result;
}

#define DENY_SYSCALL(number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static int deny_network_and_namespace_syscalls(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __NR_socket
    DENY_SYSCALL(__NR_socket),
#endif
#ifdef __NR_socketpair
    DENY_SYSCALL(__NR_socketpair),
#endif
#ifdef __NR_connect
    DENY_SYSCALL(__NR_connect),
#endif
#ifdef __NR_bind
    DENY_SYSCALL(__NR_bind),
#endif
#ifdef __NR_listen
    DENY_SYSCALL(__NR_listen),
#endif
#ifdef __NR_accept
    DENY_SYSCALL(__NR_accept),
#endif
#ifdef __NR_accept4
    DENY_SYSCALL(__NR_accept4),
#endif
#ifdef __NR_sendto
    DENY_SYSCALL(__NR_sendto),
#endif
#ifdef __NR_sendmsg
    DENY_SYSCALL(__NR_sendmsg),
#endif
#ifdef __NR_recvfrom
    DENY_SYSCALL(__NR_recvfrom),
#endif
#ifdef __NR_recvmsg
    DENY_SYSCALL(__NR_recvmsg),
#endif
#ifdef __NR_shutdown
    DENY_SYSCALL(__NR_shutdown),
#endif
#ifdef __NR_mount
    DENY_SYSCALL(__NR_mount),
#endif
#ifdef __NR_umount2
    DENY_SYSCALL(__NR_umount2),
#endif
#ifdef __NR_pivot_root
    DENY_SYSCALL(__NR_pivot_root),
#endif
#ifdef __NR_chroot
    DENY_SYSCALL(__NR_chroot),
#endif
#ifdef __NR_unshare
    DENY_SYSCALL(__NR_unshare),
#endif
#ifdef __NR_setns
    DENY_SYSCALL(__NR_setns),
#endif
#ifdef __NR_ptrace
    DENY_SYSCALL(__NR_ptrace),
#endif
#ifdef __NR_bpf
    DENY_SYSCALL(__NR_bpf),
#endif
#ifdef __NR_perf_event_open
    DENY_SYSCALL(__NR_perf_event_open),
#endif
#ifdef __NR_userfaultfd
    DENY_SYSCALL(__NR_userfaultfd),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") != 0) {
    fprintf(stderr, "usage: loka-sandbox WORKSPACE -- COMMAND [ARG ...]\n");
    return 125;
  }

  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) return fail("Landlock is unavailable");

  unsigned long long handled = LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR |
      LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG |
      LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO |
      LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
  if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif

  struct landlock_ruleset_attr ruleset_attr = { .handled_access_fs = handled };
  int ruleset = syscall(SYS_landlock_create_ruleset, &ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset < 0) return fail("create ruleset");

  unsigned long long read_exec = LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR;
  if (add_path_rule(ruleset, "/", LANDLOCK_ACCESS_FS_EXECUTE, 1) < 0 ||
      add_path_rule(ruleset, "/usr", read_exec, 1) < 0 ||
      add_path_rule(ruleset, "/lib", read_exec, 0) < 0 ||
      add_path_rule(ruleset, "/lib64", read_exec, 0) < 0 ||
      add_path_rule(ruleset, "/etc", LANDLOCK_ACCESS_FS_READ_DIR, 0) < 0 ||
      add_path_rule(ruleset, "/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/etc/ssl", read_exec, 0) < 0 ||
      add_path_rule(ruleset, "/etc/alternatives", read_exec, 0) < 0 ||
      add_path_rule(ruleset, "/etc/passwd", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/etc/group", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/etc/nsswitch.conf", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/etc/localtime", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/etc/gitconfig", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, "/dev/zero", LANDLOCK_ACCESS_FS_READ_FILE, 0) < 0 ||
      add_path_rule(ruleset, argv[1], handled, 1) < 0) {
    close(ruleset);
    return fail("add filesystem rule");
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
      syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) {
    close(ruleset);
    return fail("restrict filesystem");
  }
  close(ruleset);

  if (deny_network_and_namespace_syscalls() < 0) return fail("install seccomp filter");
  execvp(argv[3], &argv[3]);
  return fail("exec command");
}

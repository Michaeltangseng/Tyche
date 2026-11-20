#ifdef __APPLE__
// libproc.h needs the BSD scalar types that strict POSIX headers hide.
#define _DARWIN_C_SOURCE 1
#endif
#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <libproc.h>
#elif defined(__linux__)
#include <dirent.h>
#endif

#define CONTROL_FD 3
#define MAX_CONTROL_LINE (16u * 1024u * 1024u)
#define MAX_JSON_DEPTH 64
#define CLEANUP_GRACE_MS 2500

// ---------------------------------------------------------------------------
// Small string builder
// ---------------------------------------------------------------------------

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} sbuf;

static int sb_reserve(sbuf *buffer, size_t needed) {
  if (buffer->cap >= needed) return 0;
  size_t cap = buffer->cap ? buffer->cap : 128;
  while (cap < needed) {
    if (cap > (size_t)-1 / 2) return -1;
    cap *= 2;
  }
  char *next = realloc(buffer->data, cap);
  if (!next) return -1;
  buffer->data = next;
  buffer->cap = cap;
  return 0;
}

static int sb_append(sbuf *buffer, const char *data, size_t len) {
  if (sb_reserve(buffer, buffer->len + len + 1) != 0) return -1;
  if (len) memcpy(buffer->data + buffer->len, data, len);
  buffer->len += len;
  buffer->data[buffer->len] = '\0';
  return 0;
}

static int sb_append_char(sbuf *buffer, char value) {
  return sb_append(buffer, &value, 1);
}

static int sb_appendf(sbuf *buffer, const char *format, ...) {
  va_list args;
  va_start(args, format);
  va_list copy;
  va_copy(copy, args);
  int needed = vsnprintf(NULL, 0, format, args);
  va_end(args);
  if (needed < 0) {
    va_end(copy);
    return -1;
  }
  if (sb_reserve(buffer, buffer->len + (size_t)needed + 1) != 0) {
    va_end(copy);
    return -1;
  }
  vsnprintf(buffer->data + buffer->len, (size_t)needed + 1, format, copy);
  va_end(copy);
  buffer->len += (size_t)needed;
  return 0;
}

static void sb_free(sbuf *buffer) {
  free(buffer->data);
  buffer->data = NULL;
  buffer->len = 0;
  buffer->cap = 0;
}

// ---------------------------------------------------------------------------
// Minimal JSON parser: objects, arrays, strings, booleans, integers, null.
// ---------------------------------------------------------------------------

typedef enum {
  JSON_NULL,
  JSON_BOOL,
  JSON_NUMBER,
  JSON_STRING,
  JSON_ARRAY,
  JSON_OBJECT,
} json_type;

typedef struct json_value json_value;

struct json_value {
  json_type type;
  int boolean;
  long long number;
  char *string;
  json_value **items;
  size_t item_count;
  char **keys;
  json_value **values;
  size_t member_count;
};

static void json_free(json_value *value) {
  if (!value) return;
  if (value->type == JSON_STRING) free(value->string);
  if (value->type == JSON_ARRAY) {
    for (size_t index = 0; index < value->item_count; index++) json_free(value->items[index]);
    free(value->items);
  }
  if (value->type == JSON_OBJECT) {
    for (size_t index = 0; index < value->member_count; index++) {
      free(value->keys[index]);
      json_free(value->values[index]);
    }
    free(value->keys);
    free(value->values);
  }
  free(value);
}

static json_value *json_new(json_type type) {
  json_value *value = calloc(1, sizeof *value);
  if (value) value->type = type;
  return value;
}

typedef struct {
  const char *start;
  const char *cursor;
  const char *end;
  int depth;
} json_parser;

static void json_skip_ws(json_parser *parser) {
  while (parser->cursor < parser->end) {
    char value = *parser->cursor;
    if (value != ' ' && value != '\t' && value != '\n' && value != '\r') break;
    parser->cursor++;
  }
}

static int json_hex4(json_parser *parser, unsigned int *out) {
  if ((size_t)(parser->end - parser->cursor) < 4) return -1;
  unsigned int value = 0;
  for (int index = 0; index < 4; index++) {
    char digit = *parser->cursor++;
    value <<= 4;
    if (digit >= '0' && digit <= '9') value |= (unsigned int)(digit - '0');
    else if (digit >= 'a' && digit <= 'f') value |= (unsigned int)(digit - 'a' + 10);
    else if (digit >= 'A' && digit <= 'F') value |= (unsigned int)(digit - 'A' + 10);
    else return -1;
  }
  *out = value;
  return 0;
}

static int sb_append_codepoint(sbuf *buffer, unsigned int codepoint) {
  char encoded[4];
  size_t length;
  if (codepoint <= 0x7f) {
    encoded[0] = (char)codepoint;
    length = 1;
  } else if (codepoint <= 0x7ff) {
    encoded[0] = (char)(0xc0 | (codepoint >> 6));
    encoded[1] = (char)(0x80 | (codepoint & 0x3f));
    length = 2;
  } else if (codepoint <= 0xffff) {
    encoded[0] = (char)(0xe0 | (codepoint >> 12));
    encoded[1] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    encoded[2] = (char)(0x80 | (codepoint & 0x3f));
    length = 3;
  } else if (codepoint <= 0x10ffff) {
    encoded[0] = (char)(0xf0 | (codepoint >> 18));
    encoded[1] = (char)(0x80 | ((codepoint >> 12) & 0x3f));
    encoded[2] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    encoded[3] = (char)(0x80 | (codepoint & 0x3f));
    length = 4;
  } else {
    return -1;
  }
  return sb_append(buffer, encoded, length);
}

static int json_parse_string(json_parser *parser, char **out) {
  if (parser->cursor >= parser->end || *parser->cursor != '"') return -1;
  parser->cursor++;
  sbuf buffer = {0};
  while (parser->cursor < parser->end) {
    unsigned char value = (unsigned char)*parser->cursor++;
    if (value == '"') {
      if (sb_append(&buffer, "", 0) != 0) {
        sb_free(&buffer);
        return -1;
      }
      *out = buffer.data;
      return 0;
    }
    if (value == '\\') {
      if (parser->cursor >= parser->end) goto fail;
      char escape = *parser->cursor++;
      char decoded;
      switch (escape) {
        case '"': decoded = '"'; break;
        case '\\': decoded = '\\'; break;
        case '/': decoded = '/'; break;
        case 'b': decoded = '\b'; break;
        case 'f': decoded = '\f'; break;
        case 'n': decoded = '\n'; break;
        case 'r': decoded = '\r'; break;
        case 't': decoded = '\t'; break;
        case 'u': {
          unsigned int codepoint;
          if (json_hex4(parser, &codepoint) != 0) goto fail;
          // A decoded NUL cannot be represented in argv/env/cwd.
          if (codepoint == 0) goto fail;
          if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
            if ((size_t)(parser->end - parser->cursor) < 6
                || parser->cursor[0] != '\\' || parser->cursor[1] != 'u') {
              goto fail;
            }
            parser->cursor += 2;
            unsigned int low;
            if (json_hex4(parser, &low) != 0 || low < 0xdc00 || low > 0xdfff) goto fail;
            codepoint = 0x10000u + ((codepoint - 0xd800u) << 10) + (low - 0xdc00u);
          } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
            goto fail;
          }
          if (sb_append_codepoint(&buffer, codepoint) != 0) goto fail;
          continue;
        }
        default:
          goto fail;
      }
      if (sb_append_char(&buffer, decoded) != 0) goto fail;
      continue;
    }
    if (value < 0x20) goto fail;
    if (sb_append_char(&buffer, (char)value) != 0) goto fail;
  }
fail:
  sb_free(&buffer);
  return -1;
}

static json_value *json_parse_value(json_parser *parser);

static json_value *json_parse_array(json_parser *parser) {
  parser->cursor++;
  json_value *array = json_new(JSON_ARRAY);
  if (!array) return NULL;
  json_skip_ws(parser);
  if (parser->cursor < parser->end && *parser->cursor == ']') {
    parser->cursor++;
    return array;
  }
  for (;;) {
    json_value *item = json_parse_value(parser);
    if (!item) {
      json_free(array);
      return NULL;
    }
    json_value **next = realloc(array->items, (array->item_count + 1) * sizeof *next);
    if (!next) {
      json_free(item);
      json_free(array);
      return NULL;
    }
    array->items = next;
    array->items[array->item_count++] = item;
    json_skip_ws(parser);
    if (parser->cursor >= parser->end) {
      json_free(array);
      return NULL;
    }
    if (*parser->cursor == ']') {
      parser->cursor++;
      return array;
    }
    if (*parser->cursor != ',') {
      json_free(array);
      return NULL;
    }
    parser->cursor++;
  }
}

static json_value *json_parse_object(json_parser *parser) {
  parser->cursor++;
  json_value *object = json_new(JSON_OBJECT);
  if (!object) return NULL;
  json_skip_ws(parser);
  if (parser->cursor < parser->end && *parser->cursor == '}') {
    parser->cursor++;
    return object;
  }
  for (;;) {
    json_skip_ws(parser);
    char *key = NULL;
    if (json_parse_string(parser, &key) != 0) {
      json_free(object);
      return NULL;
    }
    json_skip_ws(parser);
    if (parser->cursor >= parser->end || *parser->cursor != ':') {
      free(key);
      json_free(object);
      return NULL;
    }
    parser->cursor++;
    json_value *value = json_parse_value(parser);
    if (!value) {
      free(key);
      json_free(object);
      return NULL;
    }
    char **next_keys = malloc((object->member_count + 1) * sizeof *next_keys);
    json_value **next_values = malloc((object->member_count + 1) * sizeof *next_values);
    if (!next_keys || !next_values) {
      free(next_keys);
      free(next_values);
      free(key);
      json_free(value);
      json_free(object);
      return NULL;
    }
    if (object->member_count) {
      memcpy(next_keys, object->keys, object->member_count * sizeof *next_keys);
      memcpy(next_values, object->values, object->member_count * sizeof *next_values);
    }
    free(object->keys);
    free(object->values);
    object->keys = next_keys;
    object->values = next_values;
    object->keys[object->member_count] = key;
    object->values[object->member_count] = value;
    object->member_count++;
    json_skip_ws(parser);
    if (parser->cursor >= parser->end) {
      json_free(object);
      return NULL;
    }
    if (*parser->cursor == '}') {
      parser->cursor++;
      return object;
    }
    if (*parser->cursor != ',') {
      json_free(object);
      return NULL;
    }
    parser->cursor++;
  }
}

static json_value *json_parse_number(json_parser *parser) {
  const char *start = parser->cursor;
  if (parser->cursor < parser->end && *parser->cursor == '-') parser->cursor++;
  if (parser->cursor >= parser->end || !isdigit((unsigned char)*parser->cursor)) return NULL;
  while (parser->cursor < parser->end && isdigit((unsigned char)*parser->cursor)) parser->cursor++;
  if (parser->cursor < parser->end && *parser->cursor == '.') {
    parser->cursor++;
    while (parser->cursor < parser->end && isdigit((unsigned char)*parser->cursor)) parser->cursor++;
  }
  if (parser->cursor < parser->end && (*parser->cursor == 'e' || *parser->cursor == 'E')) {
    parser->cursor++;
    if (parser->cursor < parser->end && (*parser->cursor == '+' || *parser->cursor == '-')) parser->cursor++;
    if (parser->cursor >= parser->end || !isdigit((unsigned char)*parser->cursor)) return NULL;
    while (parser->cursor < parser->end && isdigit((unsigned char)*parser->cursor)) parser->cursor++;
  }
  size_t length = (size_t)(parser->cursor - start);
  char *text = malloc(length + 1);
  if (!text) return NULL;
  memcpy(text, start, length);
  text[length] = '\0';
  json_value *value = json_new(JSON_NUMBER);
  if (!value) {
    free(text);
    return NULL;
  }
  value->number = strtoll(text, NULL, 10);
  free(text);
  return value;
}

static json_value *json_parse_value(json_parser *parser) {
  json_skip_ws(parser);
  if (parser->cursor >= parser->end || parser->depth >= MAX_JSON_DEPTH) return NULL;
  parser->depth++;
  json_value *value = NULL;
  char token = *parser->cursor;
  if (token == '{') {
    value = json_parse_object(parser);
  } else if (token == '[') {
    value = json_parse_array(parser);
  } else if (token == '"') {
    char *text = NULL;
    if (json_parse_string(parser, &text) == 0) {
      value = json_new(JSON_STRING);
      if (value) value->string = text;
      else free(text);
    }
  } else if (token == 't' && (size_t)(parser->end - parser->cursor) >= 4
             && memcmp(parser->cursor, "true", 4) == 0) {
    parser->cursor += 4;
    value = json_new(JSON_BOOL);
    if (value) value->boolean = 1;
  } else if (token == 'f' && (size_t)(parser->end - parser->cursor) >= 5
             && memcmp(parser->cursor, "false", 5) == 0) {
    parser->cursor += 5;
    value = json_new(JSON_BOOL);
    if (value) value->boolean = 0;
  } else if (token == 'n' && (size_t)(parser->end - parser->cursor) >= 4
             && memcmp(parser->cursor, "null", 4) == 0) {
    parser->cursor += 4;
    value = json_new(JSON_NULL);
  } else if (token == '-' || isdigit((unsigned char)token)) {
    value = json_parse_number(parser);
  }
  parser->depth--;
  return value;
}

static json_value *json_parse(const char *text, size_t length) {
  json_parser parser = {text, text, text + length, 0};
  json_value *value = json_parse_value(&parser);
  if (!value) return NULL;
  json_skip_ws(&parser);
  if (parser.cursor != parser.end) {
    json_free(value);
    return NULL;
  }
  return value;
}

static json_value *json_get(json_value *object, const char *key) {
  if (!object || object->type != JSON_OBJECT) return NULL;
  for (size_t index = 0; index < object->member_count; index++) {
    if (strcmp(object->keys[index], key) == 0) return object->values[index];
  }
  return NULL;
}

// ---------------------------------------------------------------------------
// Runtime state and control channel
// ---------------------------------------------------------------------------

static int channel_dead = 0;
static int released = 0;
static int cleaning = 0;
static pid_t agent_pid = -1;
static int agent_exit_seen = 0;
static int agent_exit_code = -1;
static int agent_exit_signal = 0;
static int agent_exit_sent = 0;
static int sigchld_pipe[2] = {-1, -1};
static char *line_buffer = NULL;
static size_t line_length = 0;
static size_t line_capacity = 0;

static long long now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int set_cloexec(int descriptor) {
  int flags = fcntl(descriptor, F_GETFD, 0);
  if (flags < 0) return -1;
  return fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC);
}

static int set_nonblocking(int descriptor) {
  int flags = fcntl(descriptor, F_GETFL, 0);
  if (flags < 0) return -1;
  return fcntl(descriptor, F_SETFL, flags | O_NONBLOCK);
}

static void write_all_control(const char *data, size_t length) {
  if (channel_dead) return;
  size_t offset = 0;
  long long deadline = now_ms() + 5000;
  while (offset < length) {
    ssize_t written = write(CONTROL_FD, data + offset, length - offset);
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (now_ms() > deadline) {
        channel_dead = 1;
        return;
      }
      struct pollfd descriptor = {CONTROL_FD, POLLOUT, 0};
      int ready;
      do {
        ready = poll(&descriptor, 1, 100);
      } while (ready < 0 && errno == EINTR);
      if (ready < 0 || (ready > 0 && (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)))) {
        channel_dead = 1;
        return;
      }
      continue;
    }
    channel_dead = 1;
    return;
  }
}

static void send_error(const char *code) {
  sbuf message = {0};
  if (sb_appendf(&message, "{\"error\":{\"code\":\"%s\"}}\n", code) == 0) {
    write_all_control(message.data, message.len);
  }
  sb_free(&message);
}

static const char *signal_name(int signal_number) {
  switch (signal_number) {
    case SIGKILL: return "SIGKILL";
    case SIGTERM: return "SIGTERM";
    case SIGINT: return "SIGINT";
    case SIGQUIT: return "SIGQUIT";
    case SIGABRT: return "SIGABRT";
    case SIGSEGV: return "SIGSEGV";
    case SIGPIPE: return "SIGPIPE";
    case SIGALRM: return "SIGALRM";
    case SIGHUP: return "SIGHUP";
    case SIGUSR1: return "SIGUSR1";
    case SIGUSR2: return "SIGUSR2";
    case SIGBUS: return "SIGBUS";
    case SIGFPE: return "SIGFPE";
    case SIGILL: return "SIGILL";
    case SIGTRAP: return "SIGTRAP";
    default: break;
  }
  static char fallback[32];
  snprintf(fallback, sizeof fallback, "SIG%d", signal_number);
  return fallback;
}

static void send_started(pid_t pid) {
  sbuf message = {0};
  if (sb_appendf(&message, "{\"started\":{\"agentPid\":%d}}\n", (int)pid) == 0) {
    write_all_control(message.data, message.len);
  }
  sb_free(&message);
}

static void send_agent_exit(void) {
  if (channel_dead) return;
  sbuf message = {0};
  if (agent_exit_signal != 0) {
    sb_appendf(&message, "{\"agentExit\":{\"code\":null,\"signal\":\"%s\"}}\n",
               signal_name(agent_exit_signal));
  } else if (agent_exit_code >= 0) {
    sb_appendf(&message, "{\"agentExit\":{\"code\":%d,\"signal\":null}}\n", agent_exit_code);
  } else {
    sb_appendf(&message, "{\"agentExit\":{\"code\":null,\"signal\":null}}\n");
  }
  write_all_control(message.data, message.len);
  sb_free(&message);
}

typedef struct {
  pid_t pid;
  unsigned long long start_time;
} member_entry;

static int collect_members(member_entry **out) {
  *out = NULL;
#ifdef __APPLE__
  int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)getpgrp(), NULL, 0);
  if (bytes <= 0) return 0;
  pid_t *pids = malloc((size_t)bytes);
  if (!pids) return 0;
  int used = proc_listpids(PROC_PGRP_ONLY, (uint32_t)getpgrp(), pids, bytes);
  int count = used > 0 ? used / (int)sizeof(pid_t) : 0;
  member_entry *members = calloc((size_t)count, sizeof *members);
  if (!members) {
    free(pids);
    return 0;
  }
  int found = 0;
  for (int index = 0; index < count; index++) {
    pid_t pid = pids[index];
    if (pid <= 0 || pid == getpid()) continue;
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof info);
    unsigned long long start_time = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) == (int)sizeof info) {
      start_time = (unsigned long long)info.pbi_start_tvsec;
    }
    members[found].pid = pid;
    members[found].start_time = start_time;
    found++;
  }
  free(pids);
  *out = members;
  return found;
#elif defined(__linux__)
  DIR *directory = opendir("/proc");
  if (!directory) return 0;
  member_entry *members = NULL;
  int found = 0;
  pid_t self = getpid();
  pid_t group = getpgrp();
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (!isdigit((unsigned char)entry->d_name[0])) continue;
    pid_t pid = (pid_t)strtol(entry->d_name, NULL, 10);
    if (pid <= 0 || pid == self) continue;
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
    int descriptor = open(path, O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) continue;
    char buffer[4096];
    ssize_t length = read(descriptor, buffer, sizeof buffer - 1);
    close(descriptor);
    if (length <= 0) continue;
    buffer[length] = '\0';
    char *closing = strrchr(buffer, ')');
    if (!closing) continue;
    char *cursor = closing + 2;
    int field = 0;
    pid_t process_group = 0;
    unsigned long long start_time = 0;
    char *save = NULL;
    for (char *token = strtok_r(cursor, " ", &save);
         token != NULL;
         token = strtok_r(NULL, " ", &save), field++) {
      if (field == 2) process_group = (pid_t)strtol(token, NULL, 10);
      if (field == 19) {
        start_time = strtoull(token, NULL, 10);
        break;
      }
    }
    if (field < 19 || process_group != group) continue;
    member_entry *next = realloc(members, (size_t)(found + 1) * sizeof *next);
    if (!next) {
      free(members);
      closedir(directory);
      return 0;
    }
    members = next;
    members[found].pid = pid;
    members[found].start_time = start_time;
    found++;
  }
  closedir(directory);
  *out = members;
  return found;
#else
  (void)out;
  return 0;
#endif
}

static void send_final_kill(int agent_alive) {
  member_entry *members = NULL;
  int count = collect_members(&members);
  sbuf message = {0};
  if (sb_appendf(&message, "{\"finalKill\":{\"agentAlive\":%s,\"members\":[",
                 agent_alive ? "true" : "false") == 0) {
    for (int index = 0; index < count; index++) {
      sb_appendf(&message, "%s{\"pid\":%d,\"startTime\":%llu}",
                 index == 0 ? "" : ",", (int)members[index].pid,
                 members[index].start_time);
    }
    sb_append(&message, "]}}\n", 4);
    write_all_control(message.data, message.len);
  }
  sb_free(&message);
  free(members);
}

// ---------------------------------------------------------------------------
// Child lifecycle
// ---------------------------------------------------------------------------

static void reap_children(void);
static void process_events(int timeout_ms);

static void begin_cleanup(int force) {
  if (cleaning) return;
  cleaning = 1;
  (void)kill(-getpgrp(), SIGTERM);
  long long deadline = now_ms() + (force ? 0 : CLEANUP_GRACE_MS);
  for (;;) {
    long long remaining = deadline - now_ms();
    if (remaining <= 0) break;
    // Process events during the grace so a root that exits on SIGTERM is
    // reaped and reported before finalKill.
    process_events(remaining > 100 ? 100 : (int)remaining);
  }
  process_events(0);
  if (agent_exit_seen && !agent_exit_sent) {
    send_agent_exit();
    agent_exit_sent = 1;
  }
  send_final_kill(!agent_exit_seen);
  (void)kill(-getpgrp(), SIGKILL);
  _exit(0);
}

static void reap_children(void) {
  for (;;) {
    int status = 0;
    pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid <= 0) return;
    if (pid != agent_pid || agent_exit_seen) continue;
    agent_exit_seen = 1;
    if (WIFEXITED(status)) {
      agent_exit_code = WEXITSTATUS(status);
      agent_exit_signal = 0;
    } else if (WIFSIGNALED(status)) {
      agent_exit_signal = WTERMSIG(status);
      agent_exit_code = -1;
    }
    if (!agent_exit_sent) {
      send_agent_exit();
      agent_exit_sent = 1;
    }
    if (!cleaning) begin_cleanup(0);
  }
}

static void drain_sigchld(void) {
  char buffer[64];
  for (;;) {
    ssize_t length = read(sigchld_pipe[0], buffer, sizeof buffer);
    if (length > 0) continue;
    if (length < 0 && errno == EINTR) continue;
    return;
  }
}

static void on_sigchld(int signal_number) {
  (void)signal_number;
  unsigned char byte = 1;
  (void)write(sigchld_pipe[1], &byte, 1);
}

static int read_control(void);

static void process_events(int timeout_ms) {
  struct pollfd descriptors[2];
  descriptors[0].fd = CONTROL_FD;
  descriptors[0].events = POLLIN;
  descriptors[0].revents = 0;
  descriptors[1].fd = sigchld_pipe[0];
  descriptors[1].events = POLLIN;
  descriptors[1].revents = 0;
  int ready;
  do {
    ready = poll(descriptors, 2, timeout_ms);
  } while (ready < 0 && errno == EINTR);
  if (ready > 0) {
    if (descriptors[1].revents & POLLIN) drain_sigchld();
    if (descriptors[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) {
      int ended = read_control();
      if (ended) {
        channel_dead = 1;
        if (!released && !cleaning) _exit(0);
        if (!cleaning) begin_cleanup(0);
      }
    }
  }
  reap_children();
}

static void free_string_array(char **values, int count) {
  if (!values) return;
  for (int index = 0; index < count; index++) free(values[index]);
  free(values);
}

static int release_agent(json_value *go) {
  json_value *command = json_get(go, "command");
  json_value *args = json_get(go, "args");
  json_value *environment = json_get(go, "env");
  json_value *cwd = json_get(go, "cwd");
  if (!command || command->type != JSON_STRING || !command->string || !command->string[0]
      || !cwd || cwd->type != JSON_STRING || !cwd->string
      || (args && args->type != JSON_ARRAY)
      || (environment && environment->type != JSON_OBJECT)) {
    send_error("SUPERVISOR_PROTOCOL");
    begin_cleanup(0);
    return -1;
  }
  int argument_count = args ? (int)args->item_count : 0;
  char **argv = calloc((size_t)argument_count + 2, sizeof *argv);
  if (!argv) {
    send_error("SUPERVISOR_SPAWN");
    begin_cleanup(0);
    return -1;
  }
  argv[0] = strdup(command->string);
  if (!argv[0]) {
    free(argv);
    send_error("SUPERVISOR_SPAWN");
    begin_cleanup(0);
    return -1;
  }
  for (int index = 0; index < argument_count; index++) {
    json_value *item = args->items[index];
    if (!item || item->type != JSON_STRING || !item->string) {
      free_string_array(argv, argument_count + 1);
      send_error("SUPERVISOR_PROTOCOL");
      begin_cleanup(0);
      return -1;
    }
    argv[index + 1] = strdup(item->string);
    if (!argv[index + 1]) {
      free_string_array(argv, argument_count + 1);
      send_error("SUPERVISOR_SPAWN");
      begin_cleanup(0);
      return -1;
    }
  }
  int environment_count = environment ? (int)environment->member_count : 0;
  char **envp = calloc((size_t)environment_count + 1, sizeof *envp);
  if (!envp) {
    free_string_array(argv, argument_count + 1);
    send_error("SUPERVISOR_SPAWN");
    begin_cleanup(0);
    return -1;
  }
  for (int index = 0; index < environment_count; index++) {
    json_value *value = environment->values[index];
    if (!value || value->type != JSON_STRING || !value->string) {
      free_string_array(argv, argument_count + 1);
      free_string_array(envp, environment_count);
      send_error("SUPERVISOR_PROTOCOL");
      begin_cleanup(0);
      return -1;
    }
    const char *key = environment->keys[index];
    size_t length = strlen(key) + 1 + strlen(value->string) + 1;
    envp[index] = malloc(length);
    if (!envp[index]) {
      free_string_array(argv, argument_count + 1);
      free_string_array(envp, environment_count);
      send_error("SUPERVISOR_SPAWN");
      begin_cleanup(0);
      return -1;
    }
    snprintf(envp[index], length, "%s=%s", key, value->string);
  }

  pid_t pid = fork();
  if (pid < 0) {
    free_string_array(argv, argument_count + 1);
    free_string_array(envp, environment_count);
    send_error("SUPERVISOR_SPAWN");
    begin_cleanup(0);
    return -1;
  }
  if (pid == 0) {
    if (chdir(cwd->string) != 0) _exit(127);
    execve(command->string, argv, envp);
    _exit(127);
  }
  agent_pid = pid;
  released = 1;
  send_started(pid);
  int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (devnull >= 0) {
    (void)dup2(devnull, STDIN_FILENO);
    (void)dup2(devnull, STDOUT_FILENO);
    (void)dup2(devnull, STDERR_FILENO);
    if (devnull > STDERR_FILENO) close(devnull);
  }
  free_string_array(argv, argument_count + 1);
  free_string_array(envp, environment_count);
  return 0;
}

static void handle_message(json_value *root) {
  if (!root || root->type != JSON_OBJECT) {
    send_error("SUPERVISOR_PROTOCOL");
    begin_cleanup(0);
    return;
  }
  json_value *go = json_get(root, "go");
  json_value *stop = json_get(root, "stop");
  if (go && go->type == JSON_OBJECT) {
    if (released) {
      send_error("SUPERVISOR_PROTOCOL");
      begin_cleanup(0);
      return;
    }
    release_agent(go);
    return;
  }
  if (stop && stop->type == JSON_OBJECT) {
    json_value *force = json_get(stop, "force");
    begin_cleanup(force && force->type == JSON_BOOL && force->boolean);
    return;
  }
  send_error("SUPERVISOR_PROTOCOL");
  begin_cleanup(0);
}

static int process_lines(void) {
  size_t start = 0;
  for (;;) {
    char *newline = memchr(line_buffer + start, '\n', line_length - start);
    if (!newline) break;
    size_t length = (size_t)(newline - (line_buffer + start));
    if (length > 0 && line_buffer[start + length - 1] == '\r') length--;
    if (length > 0) {
      line_buffer[start + length] = '\0';
      json_value *message = json_parse(line_buffer + start, length);
      if (!message) {
        send_error("SUPERVISOR_PROTOCOL");
        begin_cleanup(0);
        return -1;
      }
      handle_message(message);
      json_free(message);
    }
    start += (size_t)(newline - (line_buffer + start)) + 1;
  }
  if (start > 0) {
    memmove(line_buffer, line_buffer + start, line_length - start);
    line_length -= start;
    line_buffer[line_length] = '\0';
  }
  return 0;
}

static int read_control(void) {
  char chunk[8192];
  for (;;) {
    ssize_t length = read(CONTROL_FD, chunk, sizeof chunk);
    if (length > 0) {
      if (line_length + (size_t)length + 1 > MAX_CONTROL_LINE) {
        send_error("SUPERVISOR_PROTOCOL");
        begin_cleanup(0);
        return 1;
      }
      size_t needed = line_length + (size_t)length + 1;
      if (needed > line_capacity) {
        size_t capacity = line_capacity ? line_capacity : 4096;
        while (capacity < needed) capacity *= 2;
        char *next = realloc(line_buffer, capacity);
        if (!next) {
          send_error("SUPERVISOR_INTERNAL");
          begin_cleanup(0);
          return 1;
        }
        line_buffer = next;
        line_capacity = capacity;
      }
      memcpy(line_buffer + line_length, chunk, (size_t)length);
      line_length += (size_t)length;
      line_buffer[line_length] = '\0';
      if (process_lines() != 0) return 1;
      continue;
    }
    if (length == 0) return 1;
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
    return 1;
  }
}

int main(void) {
  (void)signal(SIGTERM, SIG_IGN);
  (void)signal(SIGPIPE, SIG_IGN);
  if (set_cloexec(CONTROL_FD) != 0) _exit(1);
  if (set_nonblocking(CONTROL_FD) != 0) _exit(1);
  if (pipe(sigchld_pipe) != 0) _exit(1);
  if (set_cloexec(sigchld_pipe[0]) != 0 || set_cloexec(sigchld_pipe[1]) != 0) _exit(1);
  if (set_nonblocking(sigchld_pipe[0]) != 0 || set_nonblocking(sigchld_pipe[1]) != 0) _exit(1);
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = on_sigchld;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  if (sigaction(SIGCHLD, &action, NULL) != 0) _exit(1);
  for (;;) {
    process_events(-1);
  }
}

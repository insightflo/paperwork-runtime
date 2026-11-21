import { AsyncLocalStorage } from "node:async_hooks";

/**
 * [목적] "지금 이 async context 가 DB 트랜잭션 안인가"를 전파하는 경량 표시.
 *   withReplacementFirstDelivery 처럼 deliver(tx) 를 Postgres 트랜잭션 안에서 실행하는
 *   경로는 커넥션/락을 붙든 채로 workflow-core Rust helper 서브프로세스를 스폰할 수 없다 —
 *   스폰 대기가 트랜잭션 점유 시간을 늘리고 다른 async 작업의 진행을 막는다(Observation ①).
 *   이 모듈의 표시를 workflow-core-client 가 읽어, tx 안에서는 스폰 없이 in-process TS 팔로 간다.
 * [주의] 표시는 AsyncLocalStorage 전파다 — await·중첩 콜백을 넘어도 유지되고 콜백이 반환되거나
 *   던지면 자동 해제된다(컨텍스트 복원). db.transaction 본문과 1:1 로만 감싼다: 표시되지 않은
 *   트랜잭션은 감지할 수 없고, 트랜잭션 밖 작업을 감싸면 Rust 경로를 과도하게 끈다.
 * [수정시 영향] 소비자는 workflow-core-client.ts(runWorkflowCoreSubcommand·runWithNodeFallback)다.
 *   같은 보호가 필요한 새 db.transaction 경로는 이 파일로 본문을 감싼다.
 */

const dbTransactionDepth = new AsyncLocalStorage<number>();

/** 현재 async context 가 runInsideDbTransaction 으로 표시된 DB 트랜잭션 안인지 반환한다. */
export function isInsideDbTransaction(): boolean {
  return (dbTransactionDepth.getStore() ?? 0) > 0;
}

/**
 * work 를 DB 트랜잭션 내부로 표시해 실행한다. 중첩 호출은 depth 만 증가하고 각 run 종료 시
 *   AsyncLocalStorage 가 외부 컨텍스트로 자동 복원한다. 반환값은 work 의 것을 그대로 통과시킨다
 *   (Promise 포함 — 여기서 await 하지 않아야 표시가 콜백 수명과 정확히 일치한다).
 */
export function runInsideDbTransaction<T>(work: () => T): T {
  return dbTransactionDepth.run((dbTransactionDepth.getStore() ?? 0) + 1, work);
}

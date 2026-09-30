# Stock Signal Desk — 시놀로지 Container Manager(Docker)용 이미지
# 외부 npm 패키지가 없어 Node 공식 이미지에 코드만 복사한다.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Seoul

WORKDIR /app
COPY index.html ./
COPY lib ./lib
COPY api ./api
COPY server ./server

# 종목 목록·신호 기록·스캔 결과가 저장되는 폴더 (docker-compose 에서 NAS 폴더와 연결)
VOLUME ["/data"]
EXPOSE 8080

# 컨테이너 상태 확인 (Container Manager 에 '정상'으로 표시)
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# 시놀로지 공유 폴더(/data)에 쓰기 권한 문제가 없도록 기본 사용자로 실행한다
CMD ["node", "server/index.js"]

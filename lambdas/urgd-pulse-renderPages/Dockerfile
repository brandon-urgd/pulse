FROM public.ecr.aws/shelf/lambda-libreoffice-base:26.2-node22-x86_64

# Copy package files and install dependencies
COPY package.json package-lock.json* ${LAMBDA_TASK_ROOT}/
RUN cd ${LAMBDA_TASK_ROOT} && npm ci --omit=dev

# Copy shared utilities (same pattern as ZIP-based Lambdas)
COPY shared/ ${LAMBDA_TASK_ROOT}/shared/

# Copy handler code
COPY index.mjs ${LAMBDA_TASK_ROOT}/

# Run as non-root user for security
USER 1000

CMD ["index.handler"]

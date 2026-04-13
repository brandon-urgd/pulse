FROM public.ecr.aws/lambda/nodejs:22

# Install LibreOffice headless for DOCX → PDF conversion
RUN dnf install -y libreoffice-core libreoffice-writer && \
    dnf clean all && \
    rm -rf /var/cache/dnf

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

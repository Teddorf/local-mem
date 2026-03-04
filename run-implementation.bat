@echo off
echo ============================================
echo  local-mem - Implementacion Autonoma
echo  Inicio: %date% %time%
echo ============================================

cd /d "C:\Users\m_ben\OneDrive\Escritorio\Mike\local-mem"

call claude -p "Lee IMPLEMENTATION.md y SPEC.md. Ejecuta la implementacion completa en modo autonomo (seccion 'Modo de Ejecucion Autonoma'). Implementa TODAS las fases (1-5) siguiendo el indice de tareas, respetando dependencias, ejecutando reviews inline, y generando IMPLEMENTATION_REPORT.md al final. NO preguntes nada. Si hay ambiguedad, usa el SPEC como fuente de verdad." --dangerously-skip-permissions

echo ============================================
echo  Finalizado: %date% %time%
echo ============================================
pause
